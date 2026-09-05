import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { isDeepStrictEqual } from 'node:util';
import type { CanonicalReadingState, ReadingAnchor, ReadingEventReceipt, RevisionPositionAcknowledgement } from '@bookorbit/types';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { isNewerReadingEvent } from './reading-event';

type RevisionDb = NodePgDatabase<typeof schema>;
type RevisionTransaction = Parameters<Parameters<RevisionDb['transaction']>[0]>[0];
const heads = schema.readingEventHeads;
const events = schema.canonicalReadingEvents;
const acknowledgements = schema.readingPositionAcknowledgements;
const scope = (userId: number, bookFileId: number) => and(eq(heads.userId, userId), eq(heads.bookFileId, bookFileId));
const eventScope = (userId: number, bookFileId: number) => and(eq(events.userId, userId), eq(events.bookFileId, bookFileId));

export async function resetCanonicalReadingEvents(tx: RevisionTransaction, userId: number, fileIds: readonly number[]): Promise<void> {
  // Keep the same lock order for overlapping bulk resets and individual reading events.
  const sorted = [...new Set(fileIds)].sort((a, b) => a - b);
  for (let offset = 0; offset < sorted.length; offset += 100) {
    await tx
      .insert(heads)
      .values(sorted.slice(offset, offset + 100).map((bookFileId) => ({ userId, bookFileId, resetGeneration: 1 })))
      .onConflictDoUpdate({ target: [heads.userId, heads.bookFileId], set: { eventId: null, resetGeneration: sql`${heads.resetGeneration} + 1` } });
  }
}

@Injectable()
export class CanonicalReadingService {
  constructor(@Inject(DB) private readonly db: RevisionDb) {}

  async state(userId: number, fileId: number, libraryId: number): Promise<CanonicalReadingState> {
    await this.requireFile(this.db, fileId, libraryId);
    return this.readState(this.db, userId, fileId);
  }

  async record(userId: number, fileId: number, libraryId: number, incoming: ReadingAnchor): Promise<ReadingEventReceipt> {
    const anchor: ReadingAnchor = JSON.parse(JSON.stringify(incoming));
    const identity = anchor.event;
    if (!identity || anchor.schemaVersion !== 1 || anchor.bookFileId !== fileId)
      throw new BadRequestException('A versioned file anchor and reading event are required');
    return this.db.transaction(async (tx) => {
      const file = await this.requireFile(tx, fileId, libraryId);
      if (anchor.bookId !== file.bookId) throw new BadRequestException('Anchor book identity does not match the file');
      await this.requireRevision(tx, fileId, anchor.revision, anchor.provisionalSha256);
      await this.lockHead(tx, userId, fileId);
      const state = await this.readState(tx, userId, fileId);
      if (identity.resetGeneration !== state.resetGeneration) return { ...state, outcome: 'reset_required' };
      const [duplicate] = await tx
        .select({ anchor: events.anchor })
        .from(events)
        .where(and(eventScope(userId, fileId), eq(events.id, identity.id)))
        .limit(1);
      if (duplicate) {
        if (!isDeepStrictEqual(duplicate.anchor, anchor)) throw new ConflictException('Reading event identity was reused with different content');
        return { ...state, outcome: 'duplicate' };
      }
      const [latest] = await tx
        .select({ sequence: events.deviceSequence })
        .from(events)
        .where(and(eventScope(userId, fileId), eq(events.deviceId, identity.deviceId), eq(events.resetGeneration, state.resetGeneration)))
        .orderBy(desc(events.deviceSequence))
        .limit(1);
      if (latest && latest.sequence >= identity.deviceSequence) return { ...state, outcome: 'superseded' };
      await tx.insert(events).values({
        userId,
        bookFileId: fileId,
        id: identity.id,
        deviceId: identity.deviceId,
        deviceSequence: identity.deviceSequence,
        resetGeneration: identity.resetGeneration,
        occurredAt: new Date(identity.occurredAt),
        anchor,
      });
      if (state.anchor?.event && !isNewerReadingEvent(identity, state.anchor.event)) return { ...state, outcome: 'superseded' };
      await tx.update(heads).set({ eventId: identity.id }).where(scope(userId, fileId));
      return { resetGeneration: state.resetGeneration, anchor, outcome: 'accepted' };
    });
  }

  async acknowledge(
    userId: number,
    fileId: number,
    libraryId: number,
    deviceId: string,
    copyId: string,
    acknowledgement: RevisionPositionAcknowledgement,
  ): Promise<CanonicalReadingState> {
    return this.db.transaction(async (tx) => {
      await this.requireFile(tx, fileId, libraryId);
      await this.requireRevision(tx, fileId, acknowledgement.revision);
      await this.lockHead(tx, userId, fileId);
      const state = await this.readState(tx, userId, fileId);
      if (state.anchor?.event?.id !== acknowledgement.eventId)
        throw new ConflictException('Reading event changed before restoration was acknowledged');
      await tx
        .insert(acknowledgements)
        .values({ userId, bookFileId: fileId, deviceId, copyId, acknowledgement })
        .onConflictDoUpdate({
          target: [acknowledgements.userId, acknowledgements.bookFileId, acknowledgements.deviceId, acknowledgements.copyId],
          set: { acknowledgement },
        });
      return state;
    });
  }

  private async lockHead(tx: RevisionTransaction, userId: number, fileId: number) {
    await tx.insert(heads).values({ userId, bookFileId: fileId }).onConflictDoNothing();
    await tx.select({ generation: heads.resetGeneration }).from(heads).where(scope(userId, fileId)).for('update');
  }

  private async readState(db: RevisionDb | RevisionTransaction, userId: number, fileId: number): Promise<CanonicalReadingState> {
    const [row] = await db
      .select({ resetGeneration: heads.resetGeneration, anchor: events.anchor })
      .from(heads)
      .leftJoin(events, and(eq(events.userId, heads.userId), eq(events.bookFileId, heads.bookFileId), eq(events.id, heads.eventId)))
      .where(scope(userId, fileId))
      .limit(1);
    return row ?? { resetGeneration: 0, anchor: null };
  }

  private async requireFile(db: RevisionDb | RevisionTransaction, fileId: number, libraryId: number) {
    const [file] = await db
      .select({ bookId: schema.bookFiles.bookId })
      .from(schema.bookFiles)
      .innerJoin(schema.books, eq(schema.books.id, schema.bookFiles.bookId))
      .where(and(eq(schema.bookFiles.id, fileId), eq(schema.books.libraryId, libraryId)))
      .limit(1);
    if (!file) throw new NotFoundException('File not found in this library');
    return file;
  }

  private async requireRevision(db: RevisionDb | RevisionTransaction, fileId: number, revision: string, provisionalSha256?: string) {
    if (/^sha256:[a-f0-9]{64}$/.test(revision)) {
      if (provisionalSha256 && revision !== `sha256:${provisionalSha256}`)
        throw new BadRequestException('Provisional identity does not match the anchor');
      return;
    }
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(revision)) throw new BadRequestException('Invalid revision identity');
    const [found] = await db
      .select({ id: schema.bookFileRevisions.id })
      .from(schema.bookFileRevisions)
      .where(and(eq(schema.bookFileRevisions.bookFileId, fileId), eq(schema.bookFileRevisions.id, revision)))
      .limit(1);
    if (!found) throw new NotFoundException('Revision not found for this file');
  }
}

import { RevisionCoordinationService } from './revision-coordination.service';
import { ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import type { RevisionPublicationReason } from '@bookorbit/types';
import { DB } from '../../db';
import { FileLockService, bookOperationLockKey } from '../../common/file-lock.service';
import * as schema from '../../db/schema';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { EpubManifestService } from './epub-manifest.service';
import {
  publicationPaths,
  publishStagedFile,
  requireInspectedFile,
  stagePublication,
  removeCancelledPublication,
} from './revision-publication.files';
import { inspectStableFile, sameFileSignature } from './file-inspection';
import type { RevisionPublicationAuthority } from './revision-publication-authority';
import { KoboFileStateService } from '../kobo/kobo-file-state.service';
import { RevisionRetentionService } from './revision-retention.service';

type Db = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

@Injectable()
export class RevisionPublicationService {
  private readonly logger = new Logger(RevisionPublicationService.name);
  private recovering = false;
  private activePreparations = 0;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly manifests: EpubManifestService,
    private readonly locks: FileLockService,
    private readonly retention: RevisionRetentionService,
    private readonly koboFiles: KoboFileStateService,
    private readonly coordination: RevisionCoordinationService,
  ) {}

  async prepare(
    bookFileId: number,
    libraryId: number,
    expectedRevisionId: string,
    inputPath: string,
    reason: RevisionPublicationReason,
    authority?: RevisionPublicationAuthority,
    expectedInputSha256?: string,
    expectedTarget?: { bookId: number; absolutePath: string },
  ) {
    if (this.activePreparations >= 2) throw new ServiceUnavailableException('Revision preparation is busy; retry later');
    this.activePreparations++;
    const startedAt = Date.now();
    this.logger.log(
      `[book.revision_prepare] [start] bookFileId=${bookFileId} libraryId=${libraryId} reason=${reason} - revision preparation started`,
    );
    try {
      if (authority) {
        const existing = await this.ownedPublication(bookFileId, libraryId, authority);
        if (existing) {
          if (
            existing.expectedRevisionId !== expectedRevisionId ||
            existing.reason !== reason ||
            (expectedInputSha256 && existing.nextSha256 !== expectedInputSha256)
          )
            throw new ConflictException('Publication ownership was reused for another revision');
          this.logger.log(
            `[book.revision_prepare] [end] bookFileId=${bookFileId} libraryId=${libraryId} durationMs=${Date.now() - startedAt} publicationId=${existing.id} reused=true - revision preparation recovered`,
          );
          return { publicationId: existing.id, state: existing.state };
        }
      }
      const result = await this.prepareInternal(
        bookFileId,
        libraryId,
        expectedRevisionId,
        inputPath,
        reason,
        authority,
        expectedInputSha256,
        expectedTarget,
      );
      this.logger.log(
        `[book.revision_prepare] [end] bookFileId=${bookFileId} libraryId=${libraryId} durationMs=${Date.now() - startedAt} publicationId=${result.publicationId} - revision preparation completed`,
      );
      return result;
    } catch (error) {
      this.logger.warn(
        `[book.revision_prepare] [fail] bookFileId=${bookFileId} libraryId=${libraryId} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : 'Preparation failed')}" - revision preparation failed`,
      );
      throw error;
    } finally {
      this.activePreparations--;
    }
  }

  private async prepareInternal(
    bookFileId: number,
    libraryId: number,
    expectedRevisionId: string,
    inputPath: string,
    reason: RevisionPublicationReason,
    authority?: RevisionPublicationAuthority,
    expectedInputSha256?: string,
    expectedTarget?: { bookId: number; absolutePath: string },
  ) {
    const file = await this.scopedFile(this.db, bookFileId, libraryId);
    if (expectedTarget && (file.bookId !== expectedTarget.bookId || file.absolutePath !== expectedTarget.absolutePath))
      throw new ConflictException('Book assignment changed before metadata publication');
    if (!file.sha256 || file.currentRevisionId !== expectedRevisionId)
      throw new ConflictException('Refresh the current revision before replacing this file');
    if (file.format !== 'epub' && file.format !== 'kepub') throw new ConflictException('Revision replacement requires an EPUB');
    const id = randomUUID();
    const staged = await stagePublication(inputPath, file.absolutePath, id, file.sha256);
    let attemptedCommit = false;
    let committed = false;
    try {
      if (expectedInputSha256 && staged.fresh.sha256 !== expectedInputSha256)
        throw new ConflictException('The retained EPUB checksum no longer matches its revision');
      const manifest = await this.manifests.inspect(staged.stagedPath);
      await requireInspectedFile(staged.stagedPath, staged.fresh.sha256);
      attemptedCommit = true;
      await this.db.transaction(async (tx) => {
        await this.coordination.lockFile(tx, bookFileId);
        await authority?.authorize(tx);
        const locked = await this.scopedFile(tx, bookFileId, libraryId, true);
        if (
          locked.bookId !== file.bookId ||
          locked.currentRevisionId !== expectedRevisionId ||
          locked.absolutePath !== file.absolutePath ||
          locked.sha256 !== file.sha256
        ) {
          throw new ConflictException('Book file changed while preparing its replacement');
        }
        const [active] = await tx
          .select({ id: schema.revisionPublications.id })
          .from(schema.revisionPublications)
          .where(
            and(
              eq(schema.revisionPublications.bookFileId, bookFileId),
              inArray(schema.revisionPublications.state, ['prepared', 'filesystem_published']),
            ),
          )
          .limit(1);
        if (reason === 'file_write') {
          const [previous] = await tx
            .select({ contentHash: schema.bookFileRevisions.contentHash })
            .from(schema.bookFileRevisions)
            .where(and(eq(schema.bookFileRevisions.id, expectedRevisionId), eq(schema.bookFileRevisions.bookFileId, bookFileId)))
            .limit(1);
          if (!previous?.contentHash || previous.contentHash !== manifest.contentHash)
            throw new ConflictException('Metadata writing changed chapter content; publication requires review');
        }
        if (active) throw new ConflictException('A replacement for this file is already pending');
        await authority?.authorize(tx);
        await tx.insert(schema.revisionPublications).values({
          id,
          bookFileId,
          libraryId,
          expectedRevisionId,
          expectedBookId: file.bookId,
          nextRevisionId: randomUUID(),
          targetPath: file.absolutePath,
          stagedPath: staged.stagedPath,
          backupPath: staged.backupPath,
          previousSha256: file.sha256!,
          nextSha256: staged.fresh.sha256,
          nextFileHash: staged.fresh.fileHash,
          nextSizeBytes: staged.fresh.sizeBytes,
          manifest,
          reason,
          ownerKey: authority?.ownerKey,
        });
      });
      committed = true;
      return { publicationId: id, state: 'prepared' as const };
    } finally {
      if (!committed) {
        // A failed COMMIT response can still mean PostgreSQL committed the journal.
        const persisted = attemptedCommit
          ? await this.db
              .select({ id: schema.revisionPublications.id })
              .from(schema.revisionPublications)
              .where(eq(schema.revisionPublications.id, id))
              .limit(1)
              .then((rows) => rows.length > 0)
              .catch(() => true)
          : false;
        if (!persisted) await rm(staged.directory, { recursive: true, force: true });
      }
    }
  }

  async ownedPublication(bookFileId: number, libraryId: number, authority: RevisionPublicationAuthority) {
    return this.db.transaction(async (tx) => {
      await authority.authorize(tx);
      await this.scopedFile(tx, bookFileId, libraryId);
      const [journal] = await tx
        .select({
          id: schema.revisionPublications.id,
          state: schema.revisionPublications.state,
          expectedRevisionId: schema.revisionPublications.expectedRevisionId,
          nextRevisionId: schema.revisionPublications.nextRevisionId,
          nextSha256: schema.revisionPublications.nextSha256,
          reason: schema.revisionPublications.reason,
        })
        .from(schema.revisionPublications)
        .where(
          and(
            eq(schema.revisionPublications.ownerKey, authority.ownerKey),
            eq(schema.revisionPublications.bookFileId, bookFileId),
            eq(schema.revisionPublications.libraryId, libraryId),
            ne(schema.revisionPublications.state, 'failed'),
          ),
        )
        .limit(1);
      return journal ?? null;
    });
  }

  private async authorize(
    journal: typeof schema.revisionPublications.$inferSelect,
    transaction: Transaction,
    authority?: RevisionPublicationAuthority,
  ) {
    await this.coordination.lockFile(transaction, journal.bookFileId);
    if (journal.ownerKey && journal.ownerKey !== authority?.ownerKey) throw new ConflictException('This publication requires its owning operation');
    await authority?.authorize(transaction);
  }

  async resume(
    id: string,
    libraryId: number,
    authority?: RevisionPublicationAuthority,
    publishedOnly = false,
  ): Promise<{ revisionId: string; state: 'cleanup_complete' }> {
    const [journal] = await this.db
      .select({ bookFileId: schema.revisionPublications.bookFileId, targetPath: schema.revisionPublications.targetPath })
      .from(schema.revisionPublications)
      .where(and(eq(schema.revisionPublications.id, id), eq(schema.revisionPublications.libraryId, libraryId)))
      .limit(1);
    if (!journal) throw new NotFoundException('Revision publication not found');
    const file = await this.scopedFile(this.db, journal.bookFileId, libraryId);
    return this.locks.withLock(bookOperationLockKey(file.bookId), () =>
      this.locks.withLock(journal.targetPath, () => this.resumeLocked(id, libraryId, authority, publishedOnly)),
    );
  }

  // Metadata writers already hold the book operation lock while building their payload.
  async resumeWithinBookOperation(bookId: number, id: string, libraryId: number) {
    const [journal] = await this.db
      .select()
      .from(schema.revisionPublications)
      .where(and(eq(schema.revisionPublications.id, id), eq(schema.revisionPublications.libraryId, libraryId)))
      .limit(1);
    if (!journal || journal.reason !== 'file_write' || journal.expectedBookId !== bookId)
      throw new ConflictException('Metadata publication does not belong to this book operation');
    return this.locks.withLock(journal.targetPath, () => this.resumeLocked(id, libraryId));
  }

  private async resumeLocked(
    id: string,
    libraryId: number,
    authority?: RevisionPublicationAuthority,
    publishedOnly = false,
  ): Promise<{ revisionId: string; state: 'cleanup_complete' }> {
    const event = 'book.revision_publish';
    const startedAt = Date.now();
    this.logger.log(`[${event}] [start] publicationId=${id} libraryId=${libraryId} - revision publication started`);
    try {
      const [expected] = await this.db
        .select()
        .from(schema.revisionPublications)
        .where(and(eq(schema.revisionPublications.id, id), eq(schema.revisionPublications.libraryId, libraryId)))
        .limit(1);
      if (!expected) throw new NotFoundException('Revision publication not found');
      this.assertPaths(expected);
      await this.db.transaction(async (tx) => {
        await this.authorize(expected, tx, authority);
        const file = await this.scopedFile(tx, expected.bookFileId, libraryId, true);
        const [journal] = await tx.select().from(schema.revisionPublications).where(eq(schema.revisionPublications.id, id)).for('update');
        if (journal.state === 'failed') throw new ConflictException('Revision publication is cancelled or requires review');
        if (journal.state === 'cleanup_complete' || journal.state === 'database_committed') return;
        if (
          (journal.expectedBookId !== null && file.bookId !== journal.expectedBookId) ||
          file.absolutePath !== journal.targetPath ||
          file.currentRevisionId !== journal.expectedRevisionId
        ) {
          throw new ConflictException('Book file changed before publication');
        }
        const actual = await inspectStableFile(journal.targetPath);
        if (actual.status !== 'stable') throw new ConflictException('Current EPUB is unavailable; replacement requires review');
        if (actual.file.sha256 !== journal.nextSha256) {
          if (publishedOnly) throw new ConflictException('Interrupted publication has not installed the expected bytes');
          if (actual.file.sha256 !== journal.previousSha256) throw new ConflictException('Current EPUB changed outside this publication');
          await requireInspectedFile(journal.backupPath, journal.previousSha256);
          await requireInspectedFile(journal.stagedPath, journal.nextSha256);
          const currentStat = await stat(journal.targetPath, { bigint: true });
          if (!sameFileSignature(actual.file.signature, currentStat)) throw new ConflictException('Current EPUB changed during publication');
          await this.authorize(journal, tx, authority);
          await publishStagedFile(journal.stagedPath, journal.targetPath);
        }
        await tx
          .update(schema.revisionPublications)
          .set({ state: 'filesystem_published', updatedAt: new Date() })
          .where(eq(schema.revisionPublications.id, id));
      });
      await this.commitPublished(expected, authority);
      await this.cleanup(expected, authority);
      this.logger.log(
        `[${event}] [end] publicationId=${id} libraryId=${libraryId} durationMs=${Date.now() - startedAt} revisionId=${expected.nextRevisionId} - revision publication completed`,
      );
      return { revisionId: expected.nextRevisionId, state: 'cleanup_complete' };
    } catch (error) {
      this.logger.warn(
        `[${event}] [fail] publicationId=${id} libraryId=${libraryId} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : 'Publication failed')}" - revision publication failed`,
      );
      throw error;
    }
  }

  async cancel(id: string, libraryId: number, authority?: RevisionPublicationAuthority): Promise<void> {
    const [expected] = await this.db
      .select()
      .from(schema.revisionPublications)
      .where(and(eq(schema.revisionPublications.id, id), eq(schema.revisionPublications.libraryId, libraryId)))
      .limit(1);
    if (!expected) throw new NotFoundException('Revision publication not found');
    this.assertPaths(expected);
    await this.db.transaction(async (tx) => {
      await this.authorize(expected, tx, authority);
      await this.scopedFile(tx, expected.bookFileId, libraryId, true);
      const [journal] = await tx
        .select()
        .from(schema.revisionPublications)
        .where(and(eq(schema.revisionPublications.id, id), eq(schema.revisionPublications.libraryId, libraryId)))
        .for('update');
      if (!journal) throw new NotFoundException('Revision publication not found');
      await this.authorize(journal, tx, authority);
      if (journal.state === 'failed') return;
      if (journal.state !== 'prepared') throw new ConflictException('This revision has already been published');
      const current = await requireInspectedFile(journal.targetPath);
      if (current.sha256 !== journal.previousSha256) throw new ConflictException('Publication must be recovered before cancellation');
      await tx.update(schema.revisionPublications).set({ state: 'failed', updatedAt: new Date() }).where(eq(schema.revisionPublications.id, id));
    });
    await removeCancelledPublication(expected.targetPath, id);
    if (!expected.ownerKey)
      await this.db.update(schema.revisionPublications).set({ ownerSettledAt: new Date() }).where(eq(schema.revisionPublications.id, id));
  }

  @Interval(30_000)
  async recoverPending(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const pending = await this.db
        .select({ id: schema.revisionPublications.id, libraryId: schema.revisionPublications.libraryId, state: schema.revisionPublications.state })
        .from(schema.revisionPublications)
        .where(
          and(
            isNull(schema.revisionPublications.ownerKey),
            or(
              inArray(schema.revisionPublications.state, ['prepared', 'filesystem_published', 'database_committed']),
              and(eq(schema.revisionPublications.state, 'failed'), isNull(schema.revisionPublications.ownerSettledAt)),
            ),
          ),
        )
        .orderBy(asc(schema.revisionPublications.updatedAt), asc(schema.revisionPublications.id))
        .limit(100);
      for (const journal of pending) {
        try {
          if (journal.state === 'failed') await this.cancel(journal.id, journal.libraryId);
          else await this.resume(journal.id, journal.libraryId);
        } catch {
          await this.db.update(schema.revisionPublications).set({ updatedAt: new Date() }).where(eq(schema.revisionPublications.id, journal.id));
        }
      }
    } finally {
      this.recovering = false;
    }
  }

  private async commitPublished(expected: typeof schema.revisionPublications.$inferSelect, authority?: RevisionPublicationAuthority): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.authorize(expected, tx, authority);
      const file = await this.scopedFile(tx, expected.bookFileId, expected.libraryId, true);
      const [journal] = await tx.select().from(schema.revisionPublications).where(eq(schema.revisionPublications.id, expected.id)).for('update');
      if (journal.state === 'database_committed' || journal.state === 'cleanup_complete') return;
      if (
        journal.state !== 'filesystem_published' ||
        (journal.expectedBookId !== null && file.bookId !== journal.expectedBookId) ||
        file.currentRevisionId !== journal.expectedRevisionId ||
        file.absolutePath !== journal.targetPath
      ) {
        throw new ConflictException('Publication state changed before database commit');
      }
      const installed = await requireInspectedFile(journal.targetPath, journal.nextSha256);
      await this.authorize(journal, tx, authority);
      await this.commitRevision(tx, journal, installed);
    });
  }

  private async scopedFile(db: Db | Transaction, id: number, libraryId: number, lock = false) {
    const query = db
      .select({ file: schema.bookFiles })
      .from(schema.bookFiles)
      .innerJoin(schema.books, eq(schema.books.id, schema.bookFiles.bookId))
      .where(and(eq(schema.bookFiles.id, id), eq(schema.books.libraryId, libraryId)));
    const [result] = lock ? await query.for('update') : await query.limit(1);
    if (!result) throw new NotFoundException('Book file not found in this library');
    return result.file;
  }

  private assertPaths(journal: typeof schema.revisionPublications.$inferSelect): void {
    const paths = publicationPaths(journal.targetPath, journal.id);
    if (paths.stagedPath !== journal.stagedPath || paths.backupPath !== journal.backupPath)
      throw new ConflictException('Invalid publication recovery paths');
  }

  private async commitRevision(
    tx: Transaction,
    journal: typeof schema.revisionPublications.$inferSelect,
    installed: Awaited<ReturnType<typeof requireInspectedFile>>,
  ) {
    const manifest = journal.manifest;
    const [previous] = await tx
      .select()
      .from(schema.bookFileRevisions)
      .where(and(eq(schema.bookFileRevisions.id, journal.expectedRevisionId), eq(schema.bookFileRevisions.bookFileId, journal.bookFileId)))
      .limit(1);
    const changeKind = !previous?.contentHash
      ? 'unknown'
      : manifest.contentHash !== previous.contentHash
        ? 'content'
        : manifest.coverHash !== previous.coverHash
          ? 'cover'
          : manifest.metadataHash !== previous.metadataHash
            ? 'metadata'
            : 'container';
    await tx.insert(schema.bookFileRevisions).values({
      id: journal.nextRevisionId,
      bookFileId: journal.bookFileId,
      sha256: installed.sha256,
      fileHash: installed.fileHash,
      sizeBytes: installed.sizeBytes,
      reason: journal.reason,
      changeKind,
      chapters: manifest.chapters,
      manifestVersion: manifest.version,
      contentHash: manifest.contentHash,
      metadataHash: manifest.metadataHash,
      coverHash: manifest.coverHash,
    });
    const [old] = await tx
      .select({ fileHash: schema.bookFiles.fileHash, bookId: schema.bookFiles.bookId })
      .from(schema.bookFiles)
      .where(eq(schema.bookFiles.id, journal.bookFileId));
    if (old.fileHash && old.fileHash !== installed.fileHash)
      await tx
        .insert(schema.bookFileHashHistory)
        .values({ bookFileId: journal.bookFileId, fileHash: old.fileHash, reason: journal.reason })
        .onConflictDoNothing();
    if (journal.reason !== 'file_write')
      await tx
        .update(schema.bookFileRevisions)
        .set({ storagePath: journal.backupPath })
        .where(and(eq(schema.bookFileRevisions.id, journal.expectedRevisionId), eq(schema.bookFileRevisions.bookFileId, journal.bookFileId)));
    await tx
      .update(schema.bookFiles)
      .set({
        currentRevisionId: journal.nextRevisionId,
        sha256: installed.sha256,
        fileHash: installed.fileHash,
        sizeBytes: installed.sizeBytes,
        mtime: installed.mtime,
        ino: installed.ino,
        updatedAt: new Date(),
      })
      .where(eq(schema.bookFiles.id, journal.bookFileId));
    if (journal.reason === 'file_write')
      await this.koboFiles.preserveMetadataOnlyCopy(tx, old.bookId, journal.bookFileId, old.fileHash, installed.fileHash);
    await tx
      .update(schema.revisionPublications)
      .set({ state: 'database_committed', updatedAt: new Date() })
      .where(eq(schema.revisionPublications.id, journal.id));
  }

  private async cleanup(expected: typeof schema.revisionPublications.$inferSelect, authority?: RevisionPublicationAuthority): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.authorize(expected, tx, authority);
      await this.scopedFile(tx, expected.bookFileId, expected.libraryId, true);
      const [journal] = await tx.select().from(schema.revisionPublications).where(eq(schema.revisionPublications.id, expected.id)).for('update');
      if (!journal || journal.state === 'cleanup_complete') return;
      if (journal.state !== 'database_committed') throw new ConflictException('Publication must be committed before cleanup');
      const [previous] = await tx
        .select({ storagePath: schema.bookFileRevisions.storagePath })
        .from(schema.bookFileRevisions)
        .where(and(eq(schema.bookFileRevisions.id, journal.expectedRevisionId), eq(schema.bookFileRevisions.bookFileId, journal.bookFileId)))
        .limit(1);
      if (!previous) throw new ConflictException('Previous revision is missing during cleanup');
      if (journal.reason !== 'file_write' && previous.storagePath !== null) {
        const retainedPath = await this.retention.retain(journal.bookFileId, journal.expectedRevisionId, journal.backupPath, journal.previousSha256);
        await tx
          .update(schema.bookFileRevisions)
          .set({ storagePath: retainedPath })
          .where(and(eq(schema.bookFileRevisions.id, journal.expectedRevisionId), eq(schema.bookFileRevisions.bookFileId, journal.bookFileId)));
      }
      await removeCancelledPublication(journal.targetPath, journal.id);
      if (journal.reason !== 'file_write') await this.pruneRetainedFiles(journal, tx);
      await tx
        .update(schema.revisionPublications)
        .set({ state: 'cleanup_complete', updatedAt: new Date() })
        .where(eq(schema.revisionPublications.id, journal.id));
    });
  }
  private async pruneRetainedFiles(journal: typeof schema.revisionPublications.$inferSelect, tx: Transaction): Promise<void> {
    const [latest] = await tx
      .select({ expectedRevisionId: schema.revisionPublications.expectedRevisionId })
      .from(schema.revisionPublications)
      .where(
        and(
          eq(schema.revisionPublications.bookFileId, journal.bookFileId),
          inArray(schema.revisionPublications.state, ['database_committed', 'cleanup_complete']),
        ),
      )
      .orderBy(desc(schema.revisionPublications.createdAt), desc(schema.revisionPublications.id))
      .limit(1);
    if (!latest) return;
    const old = await tx
      .select({ revisionId: schema.bookFileRevisions.id, storagePath: schema.bookFileRevisions.storagePath, journal: schema.revisionPublications })
      .from(schema.bookFileRevisions)
      .innerJoin(
        schema.revisionPublications,
        and(
          eq(schema.revisionPublications.expectedRevisionId, schema.bookFileRevisions.id),
          eq(schema.revisionPublications.bookFileId, schema.bookFileRevisions.bookFileId),
        ),
      )
      .where(
        and(
          eq(schema.bookFileRevisions.bookFileId, journal.bookFileId),
          ne(schema.bookFileRevisions.id, latest.expectedRevisionId),
          isNotNull(schema.bookFileRevisions.storagePath),
          inArray(schema.revisionPublications.state, ['database_committed', 'cleanup_complete']),
        ),
      )
      .orderBy(asc(schema.bookFileRevisions.createdAt), asc(schema.bookFileRevisions.id))
      .limit(100);
    for (const entry of old) {
      this.assertPaths(entry.journal);
      await this.retention.remove(journal.bookFileId, entry.revisionId, entry.storagePath!, entry.journal.backupPath);
      await tx.update(schema.bookFileRevisions).set({ storagePath: null }).where(eq(schema.bookFileRevisions.id, entry.revisionId));
    }
  }
}

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { DatabaseTransaction } from '../../db/transaction';
import type { RevisionPublicationAuthority } from './revision-publication-authority';
import { RevisionPublicationService } from './revision-publication.service';
import { publicationPaths, requireInspectedFile, removeCancelledPublication } from './revision-publication.files';

const journals = schema.revisionPublications;

@Injectable()
export class RevisionInterruptionService {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly publications: RevisionPublicationService,
  ) {}

  async pending(cursor?: string) {
    return this.db
      .select({
        id: journals.id,
        ownerKey: journals.ownerKey,
        libraryId: journals.libraryId,
        bookFileId: journals.bookFileId,
        nextRevisionId: journals.nextRevisionId,
        state: journals.state,
        reason: journals.reason,
      })
      .from(journals)
      .where(and(isNotNull(journals.ownerKey), isNull(journals.ownerSettledAt), cursor ? gt(journals.id, cursor) : undefined))
      .orderBy(asc(journals.id))
      .limit(100);
  }

  async settle(id: string, libraryId: number, authority: RevisionPublicationAuthority): Promise<string | null> {
    const [expected] = await this.db
      .select()
      .from(journals)
      .where(and(eq(journals.id, id), eq(journals.libraryId, libraryId), eq(journals.ownerKey, authority.ownerKey)))
      .limit(1);
    if (!expected) throw new NotFoundException('Owned revision publication not found');
    const paths = publicationPaths(expected.targetPath, id);
    if (paths.stagedPath !== expected.stagedPath || paths.backupPath !== expected.backupPath)
      throw new ConflictException('Invalid publication recovery paths');
    const published = await this.db.transaction(async (tx) => {
      await authority.authorize(tx);
      const [file] = await tx
        .select({ absolutePath: schema.bookFiles.absolutePath })
        .from(schema.bookFiles)
        .innerJoin(schema.books, eq(schema.books.id, schema.bookFiles.bookId))
        .where(and(eq(schema.bookFiles.id, expected.bookFileId), eq(schema.books.libraryId, libraryId)))
        .for('update', { of: schema.bookFiles });
      if (!file) throw new NotFoundException('Book file not found in the publication library');
      const [journal] = await tx.select().from(journals).where(eq(journals.id, id)).for('update');
      if (journal.state === 'failed') return false;
      if (journal.state === 'database_committed' || journal.state === 'cleanup_complete') return true;
      if (file.absolutePath !== journal.targetPath) throw new ConflictException('Publication path changed before recovery');
      const actual = await requireInspectedFile(journal.targetPath);
      if (actual.sha256 === journal.nextSha256 && (journal.nextSha256 !== journal.previousSha256 || journal.state !== 'prepared')) return true;
      if (actual.sha256 !== journal.previousSha256 || journal.state !== 'prepared')
        throw new ConflictException('Interrupted publication requires review of an external replacement');
      await tx.update(journals).set({ state: 'failed', updatedAt: new Date() }).where(eq(journals.id, id));
      return false;
    });
    if (published) return (await this.publications.resume(id, libraryId, authority, true)).revisionId;
    await removeCancelledPublication(expected.targetPath, id);
    return null;
  }

  async acknowledge(tx: DatabaseTransaction, id: string, ownerKey: string): Promise<void> {
    const [row] = await tx
      .update(journals)
      .set({ ownerSettledAt: new Date() })
      .where(and(eq(journals.id, id), eq(journals.ownerKey, ownerKey), inArray(journals.state, ['failed', 'cleanup_complete'])))
      .returning({ id: journals.id });
    if (!row) throw new ConflictException('Publication recovery is not complete');
  }
}

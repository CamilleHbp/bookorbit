import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DB } from '../../db';
import type { DatabaseTransaction } from '../../db/transaction';
import * as schema from '../../db/schema';

@Injectable()
export class RevisionCoordinationService {
  constructor(@Inject(DB) private readonly db: NodePgDatabase<typeof schema>) {}

  async lockFile(tx: DatabaseTransaction, fileId: number): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(183726, ${fileId})`);
  }

  async withRelocation<T>(fileIds: number[], relocate: () => Promise<T>, expected?: { fileId: number; bookId: number; path: string }[]): Promise<T> {
    const lockedIds = new Set(fileIds);
    if (expected?.some((item) => !lockedIds.has(item.fileId))) throw new ConflictException('Every relocated file must be locked');
    const ordered = [...lockedIds].sort((a, b) => a - b);
    if (!ordered.length) return relocate();
    return this.db.transaction(async (tx) => {
      for (const id of ordered) await this.lockFile(tx, id);
      for (let offset = 0; offset < ordered.length; offset += 100) {
        const [pending] = await tx
          .select({ id: schema.revisionPublications.id })
          .from(schema.revisionPublications)
          .where(
            and(
              inArray(schema.revisionPublications.bookFileId, ordered.slice(offset, offset + 100)),
              or(
                inArray(schema.revisionPublications.state, ['prepared', 'filesystem_published', 'database_committed']),
                and(isNotNull(schema.revisionPublications.ownerKey), isNull(schema.revisionPublications.ownerSettledAt)),
                and(eq(schema.revisionPublications.state, 'failed'), isNull(schema.revisionPublications.ownerSettledAt)),
              ),
            ),
          )
          .limit(1);
        if (pending) throw new ConflictException('A file update must finish recovery before this book can move or rename');
      }
      for (let offset = 0; expected && offset < expected.length; offset += 100) {
        const batch = expected.slice(offset, offset + 100);
        const files = await tx
          .select({ id: schema.bookFiles.id, bookId: schema.bookFiles.bookId, path: schema.bookFiles.absolutePath })
          .from(schema.bookFiles)
          .where(
            inArray(
              schema.bookFiles.id,
              batch.map((file) => file.fileId),
            ),
          );
        const byId = new Map(files.map((file) => [file.id, file]));
        if (batch.some((item) => byId.get(item.fileId)?.bookId !== item.bookId || byId.get(item.fileId)?.path !== item.path))
          throw new ConflictException('The book location changed after the move was planned');
      }
      return relocate();
    });
  }
}

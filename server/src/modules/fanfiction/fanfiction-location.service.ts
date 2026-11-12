import { reservationKey } from './fanfiction-story-identity';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { ConflictException, Injectable } from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../db/transaction';
import { fanfictionSources as sources, fanfictionDiscoveryCandidates as candidates } from '../../db/schema';

@Injectable()
export class FanfictionLocationService {
  constructor(private readonly runtime: FanficfareRuntimeService) {}

  async assertMergeSafe(tx: DatabaseTransaction, bookId: number): Promise<void> {
    const [managed] = await tx
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.bookId, bookId), ne(sources.state, 'unlinked')))
      .limit(1);
    if (managed) throw new ConflictException('A managed story cannot be removed by a folder merge. Choose a different destination.');
  }

  async updatePaths(tx: DatabaseTransaction, bookId: number, updates: { id: number; relPath: string | null }[]): Promise<void> {
    for (let offset = 0; offset < updates.length; offset += 100) {
      const batch = updates.slice(offset, offset + 100).filter((update) => update.relPath !== null);
      if (!batch.length) continue;
      const paths = sql`case ${sources.bookFileId} ${sql.join(
        batch.map((update) => sql`when ${update.id} then ${update.relPath}::text`),
        sql` `,
      )} end`;
      await tx
        .update(sources)
        .set({ relativePath: paths, updatedAt: sql`now()` })
        .where(
          and(
            eq(sources.bookId, bookId),
            inArray(
              sources.bookFileId,
              batch.map((update) => update.id),
            ),
            ne(sources.state, 'unlinked'),
          ),
        );
    }
  }

  async moveBook(tx: DatabaseTransaction, bookId: number, previousLibraryId: number, libraryId: number, folderId: number): Promise<void> {
    const acrossLibraries = previousLibraryId !== libraryId;
    if (acrossLibraries) {
      const moving = await tx
        .select({ id: sources.id, url: sources.canonicalUrl })
        .from(sources)
        .where(and(eq(sources.bookId, bookId), ne(sources.state, 'unlinked')))
        .for('update');
      for (const source of moving) {
        const key = await reservationKey(tx, this.runtime, libraryId, source.url);
        const [existing] = await tx
          .select({ id: sources.id })
          .from(sources)
          .where(and(eq(sources.libraryId, libraryId), eq(sources.canonicalKey, key)))
          .limit(1);
        if (existing) throw new ConflictException('The destination library already has this story source');
        await tx.update(sources).set({ canonicalKey: key, libraryId }).where(eq(sources.id, source.id));
      }
      await tx.delete(candidates).where(eq(candidates.bookId, bookId));
    }
    await tx
      .update(sources)
      .set({
        libraryId,
        folderId,
        updatedAt: sql`now()`,
        ...(acrossLibraries ? { version: sql`${sources.version} + 1` } : {}),
      })
      .where(and(eq(sources.bookId, bookId), ne(sources.state, 'unlinked')));
  }
}

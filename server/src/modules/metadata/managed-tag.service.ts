import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, notExists } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../db/transaction';
import { bookMetadata, books, bookTags, bookTagSources, tags } from '../../db/schema';

export interface ManagedTagSource {
  key: string;
  libraryId: number;
}

@Injectable()
export class ManagedTagService {
  private readonly logger = new Logger(ManagedTagService.name);

  async keepPersonal(tx: DatabaseTransaction, bookId: number, source: ManagedTagSource, names: string[]): Promise<void> {
    const metadata = await this.context(tx, bookId, source);
    if (!names.length || metadata.lockedFields?.includes('tags')) return;
    const matches = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(
        inArray(
          tags.name,
          names.map((name) => name.trim().slice(0, 200)),
        ),
      )
      .limit(1000);
    if (matches.length)
      await tx
        .update(bookTags)
        .set({ managedOnly: false })
        .where(
          and(
            eq(bookTags.bookId, bookId),
            inArray(
              bookTags.tagId,
              matches.map((tag) => tag.id),
            ),
          ),
        );
  }

  async sync(tx: DatabaseTransaction, bookId: number, source: ManagedTagSource, input: string[]): Promise<boolean> {
    if (!Array.isArray(input) || input.length > 1000 || input.some((name) => typeof name !== 'string' || name.length > 500))
      throw new BadRequestException('Managed tags exceed the supported limits');
    const startedAt = Date.now();
    this.logger.log(`[metadata.managed_tags] [start] bookId=${bookId} libraryId=${source.libraryId} - updating source tags`);
    try {
      const metadata = await this.context(tx, bookId, source);
      let changed = false;
      if (!metadata.lockedFields?.includes('tags')) {
        const names = [...new Set(input.map((name) => name.trim().slice(0, 200)).filter(Boolean))].sort();
        const scope = and(eq(bookTagSources.bookId, bookId), eq(bookTagSources.sourceKey, source.key));
        const previous = await tx
          .select({ name: tags.name })
          .from(bookTagSources)
          .innerJoin(tags, eq(tags.id, bookTagSources.tagId))
          .where(scope)
          .limit(1001);
        const previousNames = previous.map((row) => row.name).sort();
        changed = names.length !== previousNames.length || names.some((name, index) => name !== previousNames[index]);
        if (changed) {
          await tx.delete(bookTagSources).where(scope);
          if (names.length) {
            await tx
              .insert(tags)
              .values(names.map((name) => ({ name })))
              .onConflictDoNothing();
            const matched = await tx.select({ id: tags.id }).from(tags).where(inArray(tags.name, names)).limit(1000);
            await tx
              .insert(bookTags)
              .values(matched.map(({ id }) => ({ bookId, tagId: id, managedOnly: true })))
              .onConflictDoNothing();
            await tx
              .insert(bookTagSources)
              .values(matched.map(({ id }) => ({ bookId, tagId: id, sourceKey: source.key })))
              .onConflictDoNothing();
          }
          await tx.delete(bookTags).where(
            and(
              eq(bookTags.bookId, bookId),
              eq(bookTags.managedOnly, true),
              notExists(
                tx
                  .select({ id: bookTagSources.tagId })
                  .from(bookTagSources)
                  .where(and(eq(bookTagSources.bookId, bookTags.bookId), eq(bookTagSources.tagId, bookTags.tagId))),
              ),
            ),
          );
        }
      }
      this.logger.log(
        `[metadata.managed_tags] [end] bookId=${bookId} libraryId=${source.libraryId} durationMs=${Date.now() - startedAt} changed=${changed} locked=${metadata.lockedFields?.includes('tags') ?? false} - source tags processed`,
      );
      return changed;
    } catch (error) {
      this.logger.warn(
        `[metadata.managed_tags] [fail] bookId=${bookId} libraryId=${source.libraryId} durationMs=${Date.now() - startedAt} errorClass=ManagedTagError error="source tag update rejected" - source tags could not be updated`,
      );
      throw error;
    }
  }

  async release(tx: DatabaseTransaction, bookId: number, source: ManagedTagSource): Promise<void> {
    const [claim] = await tx
      .select({ id: bookTagSources.tagId })
      .from(bookTagSources)
      .where(and(eq(bookTagSources.bookId, bookId), eq(bookTagSources.sourceKey, source.key)))
      .limit(1);
    if (!claim) return;
    const startedAt = Date.now();
    this.logger.log(`[metadata.release_tags] [start] bookId=${bookId} libraryId=${source.libraryId} - preserving tags after unlinking`);
    try {
      await this.context(tx, bookId, source);
      const owned = tx
        .select({ id: bookTagSources.tagId })
        .from(bookTagSources)
        .where(and(eq(bookTagSources.bookId, bookId), eq(bookTagSources.sourceKey, source.key)));
      await tx
        .update(bookTags)
        .set({ managedOnly: false })
        .where(and(eq(bookTags.bookId, bookId), inArray(bookTags.tagId, owned)));
      await tx.delete(bookTagSources).where(and(eq(bookTagSources.bookId, bookId), eq(bookTagSources.sourceKey, source.key)));
      this.logger.log(
        `[metadata.release_tags] [end] bookId=${bookId} libraryId=${source.libraryId} durationMs=${Date.now() - startedAt} - tags retained`,
      );
    } catch (error) {
      this.logger.warn(
        `[metadata.release_tags] [fail] bookId=${bookId} libraryId=${source.libraryId} durationMs=${Date.now() - startedAt} errorClass=ManagedTagError error="tag release rejected" - tag ownership could not be released`,
      );
      throw error;
    }
  }

  private async context(tx: DatabaseTransaction, bookId: number, source: ManagedTagSource) {
    if (!source.key || source.key.length > 100) throw new BadRequestException('Invalid managed tag source');
    const [row] = await tx
      .select({ lockedFields: bookMetadata.lockedFields })
      .from(bookMetadata)
      .innerJoin(books, eq(books.id, bookMetadata.bookId))
      .where(and(eq(bookMetadata.bookId, bookId), eq(books.libraryId, source.libraryId)))
      .for('update', { of: bookMetadata });
    if (!row) throw new NotFoundException('Book metadata not found in this library');
    return row;
  }
}

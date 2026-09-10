import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { FanfictionPreview, FanfictionMetadataField, FanfictionMetadataValues } from '@bookorbit/types';
import { createHash } from 'node:crypto';
import type { DatabaseTransaction } from '../../db/transaction';
import { authors, bookAuthors, bookMetadata, bookGenres, genres, books, bookTags, bookTagSources, tags } from '../../db/schema';
import { normalizeMetadataText, normalizeMetadataTextKey } from '../../common/utils/metadata-text-normalize.utils';
import { ManagedTagService, type ManagedTagSource } from './managed-tag.service';
import { BookMetadataLockService } from '../book-metadata-lock/book-metadata-lock.service';
import { MetadataService } from './metadata.service';

@Injectable()
export class ManagedMetadataService {
  private readonly logger = new Logger(ManagedMetadataService.name);
  constructor(
    private readonly metadata: MetadataService,
    private readonly tags: ManagedTagService,
    private readonly locks: BookMetadataLockService,
  ) {}

  async snapshot(tx: DatabaseTransaction, bookId: number, libraryId: number, sourceKey?: string) {
    const [row] = await tx
      .select({ title: bookMetadata.title, description: bookMetadata.description, lockedFields: bookMetadata.lockedFields })
      .from(bookMetadata)
      .innerJoin(books, eq(books.id, bookMetadata.bookId))
      .where(and(eq(bookMetadata.bookId, bookId), eq(books.libraryId, libraryId)))
      .for('update', { of: bookMetadata });
    if (!row) throw new NotFoundException('Book metadata not found in this library');
    const authorRows = await tx
      .select({ name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(eq(bookAuthors.bookId, bookId))
      .orderBy(asc(bookAuthors.displayOrder))
      .limit(101);
    const tagRows = await tx
      .select({ name: tags.name })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(eq(bookTags.bookId, bookId))
      .orderBy(asc(tags.name))
      .limit(1001);
    if (authorRows.length > 100 || tagRows.length > 1000) throw new BadRequestException('Book metadata exceeds the supported review limits');
    const current: FanfictionMetadataValues = {
      title: row.title ?? '',
      description: row.description ?? '',
      authors: authorRows.map(({ name }) => name),
      tags: tagRows.map(({ name }) => name),
    };
    const genreRows = await tx
      .select({ name: genres.name })
      .from(bookGenres)
      .innerJoin(genres, eq(genres.id, bookGenres.genreId))
      .where(eq(bookGenres.bookId, bookId))
      .orderBy(asc(genres.name))
      .limit(1001);
    if (genreRows.length > 1000) throw new BadRequestException('Book genres exceed the supported review limits');
    current.genres = genreRows.map(({ name }) => name);
    const lockedFields = [...(row.lockedFields ?? [])].sort();
    const managed = sourceKey
      ? await tx
          .select({ name: tags.name })
          .from(bookTagSources)
          .innerJoin(tags, eq(tags.id, bookTagSources.tagId))
          .where(and(eq(bookTagSources.bookId, bookId), eq(bookTagSources.sourceKey, sourceKey)))
          .orderBy(asc(tags.name))
          .limit(1001)
      : [];
    if (managed.length > 1000) throw new BadRequestException('Book metadata exceeds the supported review limits');
    const managedTags = managed.map((row) => row.name);
    const customRows = sourceKey
      ? await tx
          .select({ name: tags.name })
          .from(bookTags)
          .innerJoin(tags, eq(tags.id, bookTags.tagId))
          .where(and(eq(bookTags.bookId, bookId), eq(bookTags.managedOnly, false)))
          .limit(1000)
      : [];
    const customTags = [...new Set([...current.tags.filter((tag) => !managedTags.includes(tag)), ...customRows.map((row) => row.name)])].sort();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ current, lockedFields, ...(sourceKey ? { managedTags, customTags } : {}) }))
      .digest('hex');
    return { current, lockedFields, fingerprint, managedTags, customTags };
  }

  async apply(
    tx: DatabaseTransaction,
    bookId: number,
    source: ManagedTagSource,
    preview: Pick<FanfictionPreview, 'title' | 'description' | 'authors' | 'tags' | 'genres'>,
    fields: FanfictionMetadataField[] = ['title', 'description', 'authors', 'tags', 'genres'],
    personalTags: string[] = [],
  ) {
    if (
      typeof preview.title !== 'string' ||
      !preview.title.trim() ||
      preview.title.length > 500 ||
      typeof preview.description !== 'string' ||
      preview.description.length > 256 * 1024 ||
      !Array.isArray(preview.authors) ||
      preview.authors.length > 100 ||
      preview.authors.some((name) => typeof name !== 'string' || name.length > 500)
    )
      throw new BadRequestException('Invalid managed story metadata');
    const startedAt = Date.now();
    this.logger.log(`[metadata.managed_story] [start] bookId=${bookId} libraryId=${source.libraryId} - applying story metadata`);
    try {
      const [current] = await tx
        .select({ title: bookMetadata.title, description: bookMetadata.description })
        .from(bookMetadata)
        .innerJoin(books, eq(books.id, bookMetadata.bookId))
        .where(and(eq(bookMetadata.bookId, bookId), eq(books.libraryId, source.libraryId)))
        .for('update', { of: bookMetadata });
      if (!current) throw new NotFoundException('Book metadata not found in this library');
      const selected = Object.fromEntries(fields.map((field) => [field, preview[field]]));
      const { dto: filtered } = await this.locks.filterAutomatedBookUpdate(bookId, selected, tx);
      const patch: Partial<typeof bookMetadata.$inferInsert> = {};
      if (filtered.title !== undefined && current.title !== filtered.title) patch.title = filtered.title;
      if (filtered.description !== undefined && current.description !== filtered.description) patch.description = filtered.description;
      let changed = Object.keys(patch).length > 0;
      if (changed)
        await tx
          .update(bookMetadata)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(bookMetadata.bookId, bookId));
      if (filtered.authors !== undefined) {
        const names = [
          ...new Map(
            filtered.authors.flatMap((name) => {
              const normalized = normalizeMetadataText(name);
              return normalized ? [[normalizeMetadataTextKey(normalized), normalized] as const] : [];
            }),
          ).values(),
        ];
        const previous = await tx
          .select({ name: authors.name })
          .from(bookAuthors)
          .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
          .where(eq(bookAuthors.bookId, bookId))
          .orderBy(asc(bookAuthors.displayOrder))
          .limit(101);
        if (
          previous.length !== names.length ||
          previous.some((row, index) => normalizeMetadataTextKey(row.name) !== normalizeMetadataTextKey(names[index] ?? ''))
        ) {
          await this.metadata.replaceAuthors(
            bookId,
            names.map((name) => ({ name, sortName: null })),
            { executor: tx, emitEvent: false },
          );
          changed = true;
        }
      }
      if (filtered.genres !== undefined) {
        await this.metadata.replaceGenres(bookId, filtered.genres, { executor: tx, emitEvent: false });
        changed = true;
      }
      if (filtered.tags !== undefined) changed = (await this.tags.sync(tx, bookId, source, filtered.tags)) || changed;
      if (personalTags.length) await this.tags.keepPersonal(tx, bookId, source, personalTags);
      if (changed) await tx.update(books).set({ updatedAt: new Date() }).where(eq(books.id, bookId));
      this.logger.log(
        `[metadata.managed_story] [end] bookId=${bookId} libraryId=${source.libraryId} durationMs=${Date.now() - startedAt} changed=${changed} - story metadata processed`,
      );
      return changed;
    } catch (error) {
      this.logger.warn(
        `[metadata.managed_story] [fail] bookId=${bookId} libraryId=${source.libraryId} durationMs=${Date.now() - startedAt} errorClass=ManagedMetadataError error="story metadata update rejected" - story metadata could not be applied`,
      );
      throw error;
    }
  }
}

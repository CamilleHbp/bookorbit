import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FanfictionReaderStory, FanfictionSource } from '@bookorbit/types';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { BookService } from '../book/book.service';
import type { RequestUser } from '../../common/types/request-user';
import { storyReading } from './fanfiction-reading';

@Injectable()
export class FanfictionReaderService {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly books: BookService,
  ) {}

  async forBook(bookId: number, fileId: number, user: RequestUser): Promise<FanfictionReaderStory | null> {
    const file = await this.books.verifyFileAccess(fileId, user);
    if (file.bookId !== bookId) return null;
    const [source] = await this.db
      .select()
      .from(schema.fanfictionSources)
      .where(
        and(
          eq(schema.fanfictionSources.libraryId, file.libraryId),
          eq(schema.fanfictionSources.bookId, bookId),
          eq(schema.fanfictionSources.bookFileId, fileId),
          sql`${schema.fanfictionSources.state} <> 'unlinked'`,
        ),
      )
      .limit(1);
    if (!source) return null;
    const [projection] = await this.project([source], user.id);
    return {
      id: source.id,
      bookId,
      bookFileId: fileId,
      title: projection.title,
      canonicalUrl: source.canonicalUrl,
      storyStatus: source.storyStatus,
      chapterCount: source.chapterCount,
      lastUpdatedAt: source.lastUpdatedAt?.toISOString() ?? null,
      categories: source.categories,
      reading: projection.reading!,
    };
  }

  async project<
    T extends { bookId: number | null; bookFileId: number | null; title: string; authors: string[]; chapterCount: number; storyStatus: string },
  >(sources: T[], userId: number): Promise<(T & Pick<FanfictionSource, 'sourceTitle' | 'reading'>)[]> {
    const ids = sources.flatMap((source) => (source.bookFileId ? [source.bookFileId] : []));
    if (!ids.length) return sources;
    const rows = await this.db
      .select({
        fileId: schema.bookFiles.id,
        title: schema.bookMetadata.title,
        authors: sql<
          string[]
        >`coalesce((select jsonb_agg(a.name order by ba.display_order) from ${schema.bookAuthors} ba join ${schema.authors} a on a.id = ba.author_id where ba.book_id = ${schema.bookFiles.bookId}), '[]'::jsonb)`,
        started: sql<boolean>`${schema.canonicalReadingEvents.anchor} is not null`,
        // Aggregate in PostgreSQL so a page never transfers every story's chapter manifest.
        progress: sql<{ total: number; read: number | null; nextHref: string | null }>`(
          with story_chapters as (
            select chapter, row_number() over (order by ordinal) - 1 as idx
            from jsonb_array_elements(${schema.bookFileRevisions.chapters}) with ordinality as c(chapter, ordinal)
            where chapter->>'sourceUrl' is not null
          ), position as (
            select count(*) as total, min(idx) filter (where case
              when ${schema.canonicalReadingEvents.anchor}->>'chapterSourceUrl' is not null
              then chapter->>'sourceUrl' = ${schema.canonicalReadingEvents.anchor}->>'chapterSourceUrl'
              else chapter->>'href' = ${schema.canonicalReadingEvents.anchor}->>'chapterHref' end) as matched
            from story_chapters
          ), progress as (
            select total, case when ${schema.canonicalReadingEvents.anchor} is null then 0
              when matched is not null then matched + case when (${schema.canonicalReadingEvents.anchor}->>'chapterFraction')::numeric >= 0.99 then 1 else 0 end
              else null end as read from position
          ) select jsonb_build_object('total', total, 'read', read,
            'nextHref', (select chapter->>'href' from story_chapters where idx = progress.read)) from progress
        )`,
      })
      .from(schema.bookFiles)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.bookFiles.bookId))
      .leftJoin(schema.bookFileRevisions, sql`${schema.bookFileRevisions.id}::text = ${schema.bookFiles.currentRevisionId}`)
      .leftJoin(
        schema.readingEventHeads,
        and(eq(schema.readingEventHeads.bookFileId, schema.bookFiles.id), eq(schema.readingEventHeads.userId, userId)),
      )
      .leftJoin(
        schema.canonicalReadingEvents,
        and(
          eq(schema.canonicalReadingEvents.bookFileId, schema.bookFiles.id),
          eq(schema.canonicalReadingEvents.userId, userId),
          eq(schema.canonicalReadingEvents.id, schema.readingEventHeads.eventId),
        ),
      )
      .where(inArray(schema.bookFiles.id, ids));
    const byFile = new Map(rows.map((row) => [row.fileId, row]));
    return sources.map((source) => {
      const row = source.bookFileId ? byFile.get(source.bookFileId) : undefined;
      const read = !row?.started ? 0 : row.progress.total === source.chapterCount ? row.progress.read : null;
      return {
        ...source,
        sourceTitle: source.title,
        title: row?.title || source.title,
        authors: row?.authors.length ? row.authors : source.authors,
        reading: storyReading(
          source.chapterCount,
          source.storyStatus,
          read,
          !!row?.started,
          read === null ? undefined : (row?.progress.nextHref ?? undefined),
        ),
      };
    });
  }
}

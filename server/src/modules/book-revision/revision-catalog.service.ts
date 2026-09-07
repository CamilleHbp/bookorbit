import { RevisionCoordinationService } from './revision-coordination.service';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { BookFileRevisionPage, BookFileRevisionManifest, ReadingAnchor, RevisionChapter } from '@bookorbit/types';
import { DB } from '../../db';
import type { DatabaseTransaction } from '../../db/transaction';
import * as schema from '../../db/schema';
import { resolveReadingAnchor } from './reading-anchor';

@Injectable()
export class RevisionCatalogService {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly coordination: RevisionCoordinationService,
  ) {}

  async lockCurrent(tx: DatabaseTransaction, bookFileId: number, libraryId: number, revisionId: string) {
    await this.coordination.lockFile(tx, bookFileId);
    const [file] = await tx
      .select({ bookId: schema.bookFiles.bookId, revisionId: schema.bookFiles.currentRevisionId })
      .from(schema.bookFiles)
      .innerJoin(schema.books, eq(schema.books.id, schema.bookFiles.bookId))
      .where(and(eq(schema.bookFiles.id, bookFileId), eq(schema.books.libraryId, libraryId)))
      .for('update', { of: schema.bookFiles });
    if (!file || file.revisionId !== revisionId)
      throw new ConflictException({ message: 'The installed revision changed before metadata could be committed', errorCode: 'review_required' });
    return file;
  }

  async identifyFiles(files: { bookFileId: number; sha256: string; sizeBytes: number; revisionId?: string | null }[]): Promise<(string | null)[]> {
    if (files.length > 100) throw new BadRequestException('Revision identity batches are limited to 100');
    if (!files.length) return [];
    const values = sql.join(
      files.map(
        (file, ordinal) =>
          sql`(${ordinal}::integer, ${file.bookFileId}::integer, ${file.sha256}::text, ${file.sizeBytes}::bigint, ${file.revisionId ?? null}::uuid)`,
      ),
      sql`, `,
    );
    const result = await this.db.execute<{ ordinal: number; revisionId: string | null }>(sql`
      select input.ordinal, matched.id as "revisionId"
      from (values ${values}) input(ordinal, file_id, sha256, size_bytes, revision_id)
      left join lateral (
        select id from ${schema.bookFileRevisions} revision
        where revision.book_file_id = input.file_id and revision.sha256 = input.sha256 and revision.size_bytes = input.size_bytes
          and (input.revision_id is null or revision.id = input.revision_id)
        order by revision.created_at desc, revision.id desc limit 1
      ) matched on true order by input.ordinal
    `);
    return result.rows.map((row) => row.revisionId);
  }

  async discoveryCutoff(libraryId: number): Promise<number> {
    const [row] = await this.db
      .select({ id: sql<number>`coalesce(max(${schema.bookFiles.id}), 0)` })
      .from(schema.bookFiles)
      .innerJoin(schema.books, eq(schema.books.id, schema.bookFiles.bookId))
      .where(eq(schema.books.libraryId, libraryId));
    return row.id;
  }

  async fileLocation(id: number, libraryId: number) {
    const [file] = await this.db
      .select({
        id: schema.bookFiles.id,
        bookId: schema.bookFiles.bookId,
        absolutePath: schema.bookFiles.absolutePath,
        libraryFolderId: schema.bookFiles.libraryFolderId,
        relPath: schema.bookFiles.relPath,
      })
      .from(schema.bookFiles)
      .innerJoin(schema.books, eq(schema.books.id, schema.bookFiles.bookId))
      .where(and(eq(schema.bookFiles.id, id), eq(schema.books.libraryId, libraryId)))
      .limit(1);
    if (!file) throw new NotFoundException('Book file is no longer in this library');
    return file;
  }

  async discoveryFiles(libraryId: number, afterId: number, cutoffId: number) {
    return this.db
      .select({
        id: schema.bookFiles.id,
        bookId: schema.bookFiles.bookId,
        absolutePath: schema.bookFiles.absolutePath,
        libraryFolderId: schema.bookFiles.libraryFolderId,
      })
      .from(schema.bookFiles)
      .innerJoin(schema.books, eq(schema.books.id, schema.bookFiles.bookId))
      .where(
        and(
          eq(schema.books.libraryId, libraryId),
          inArray(schema.bookFiles.format, ['epub']),
          gt(schema.bookFiles.id, afterId),
          lte(schema.bookFiles.id, cutoffId),
        ),
      )
      .orderBy(asc(schema.bookFiles.id))
      .limit(100);
  }

  async lockFileLocation(
    tx: DatabaseTransaction,
    libraryId: number,
    expected: { id: number; bookId: number; absolutePath: string; libraryFolderId: number },
  ) {
    await this.coordination.lockFile(tx, expected.id);
    const [file] = await tx
      .select({ id: schema.bookFiles.id })
      .from(schema.bookFiles)
      .innerJoin(schema.books, eq(schema.books.id, schema.bookFiles.bookId))
      .where(
        and(
          eq(schema.books.libraryId, libraryId),
          eq(schema.bookFiles.id, expected.id),
          eq(schema.bookFiles.bookId, expected.bookId),
          eq(schema.bookFiles.absolutePath, expected.absolutePath),
          eq(schema.bookFiles.libraryFolderId, expected.libraryFolderId),
        ),
      )
      .for('update', { of: schema.bookFiles });
    if (!file) throw new ConflictException('Book file changed library or location');
  }

  async list(bookFileId: number, libraryId: number, limit = 50, cursor?: string): Promise<BookFileRevisionPage> {
    const file = await this.requireFile(bookFileId, libraryId);
    const pageSize = Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.floor(limit) : 50));
    const [before] = cursor
      ? await this.db
          .select({ id: schema.bookFileRevisions.id, createdAt: schema.bookFileRevisions.createdAt })
          .from(schema.bookFileRevisions)
          .where(and(eq(schema.bookFileRevisions.bookFileId, bookFileId), eq(schema.bookFileRevisions.id, cursor)))
          .limit(1)
      : [];
    if (cursor && !before) throw new NotFoundException('Revision cursor not found for this file');
    const rows = await this.db
      .select({
        revision: schema.bookFileRevisions.id,
        changeKind: schema.bookFileRevisions.changeKind,
        reason: schema.bookFileRevisions.reason,
        bookFileId: schema.bookFileRevisions.bookFileId,
        sha256: schema.bookFileRevisions.sha256,
        fileHash: schema.bookFileRevisions.fileHash,
        sizeBytes: schema.bookFileRevisions.sizeBytes,
        createdAt: schema.bookFileRevisions.createdAt,
        canRollback: sql<boolean>`${schema.bookFileRevisions.storagePath} is not null and ${schema.bookFileRevisions.id} <> ${file.currentRevisionId}::uuid`,
      })
      .from(schema.bookFileRevisions)
      .where(
        and(
          eq(schema.bookFileRevisions.bookFileId, bookFileId),
          before
            ? sql`(${schema.bookFileRevisions.createdAt}, ${schema.bookFileRevisions.id}) < (select ${schema.bookFileRevisions.createdAt}, ${schema.bookFileRevisions.id} from ${schema.bookFileRevisions} where ${schema.bookFileRevisions.id} = ${before.id} and ${schema.bookFileRevisions.bookFileId} = ${bookFileId})`
            : undefined,
        ),
      )
      .orderBy(desc(schema.bookFileRevisions.createdAt), desc(schema.bookFileRevisions.id))
      .limit(pageSize + 1);
    const items = rows.slice(0, pageSize).map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    return { items, nextCursor: rows.length > pageSize ? items[items.length - 1].revision : null, currentRevisionId: file.currentRevisionId };
  }

  async retained(bookFileId: number, libraryId: number, revisionId: string, expectedRevisionId: string) {
    const file = await this.requireFile(bookFileId, libraryId);
    if (file.currentRevisionId !== expectedRevisionId || revisionId === expectedRevisionId)
      throw new ConflictException({ errorCode: 'review_required', message: 'Refresh revision history before requesting rollback' });
    const revision = await this.get(bookFileId, revisionId);
    if (!revision.storagePath)
      throw new ConflictException({ errorCode: 'review_required', message: 'This historical EPUB is no longer retained for rollback' });
    return { path: revision.storagePath, sha256: revision.sha256 };
  }

  async manifest(bookFileId: number, libraryId: number, revisionId: string): Promise<BookFileRevisionManifest> {
    await this.requireFile(bookFileId, libraryId);
    const revision = await this.get(bookFileId, revisionId);
    return { revision: revision.id, bookFileId, sha256: revision.sha256, chapters: revision.chapters ?? [] };
  }

  async current(bookFileId: number, libraryId: number) {
    const file = await this.requireFile(bookFileId, libraryId);
    if (!file.currentRevisionId) throw new NotFoundException('Book file has no inspected revision');
    return this.get(bookFileId, file.currentRevisionId);
  }

  async resolve(bookFileId: number, libraryId: number, targetRevisionId: string, anchor: ReadingAnchor) {
    const file = await this.requireFile(bookFileId, libraryId);
    if ((anchor.bookFileId !== undefined && anchor.bookFileId !== bookFileId) || (anchor.bookId !== undefined && anchor.bookId !== file.bookId)) {
      throw new BadRequestException('Reading anchor belongs to a different book file');
    }
    const target = await this.get(bookFileId, targetRevisionId);
    let source: RevisionChapter[] = [];
    if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(anchor.revision)) {
      source = (await this.get(bookFileId, anchor.revision)).chapters ?? [];
    } else if (!anchor.provisionalSha256 || anchor.revision !== `sha256:${anchor.provisionalSha256}`) {
      throw new BadRequestException('Reading anchor has no valid revision identity');
    }
    const chapter = source[anchor.chapterIndex];
    const verified = chapter
      ? { ...anchor, chapterHref: chapter.href, chapterTitle: chapter.title, chapterSourceUrl: chapter.sourceUrl, chapterTextHash: chapter.textHash }
      : anchor;
    return resolveReadingAnchor(verified, targetRevisionId, target.chapters ?? [], source);
  }

  async requireRevision(bookFileId: number, revisionId: string): Promise<void> {
    await this.requireRevisions(bookFileId, [revisionId]);
  }

  async requireRevisions(bookFileId: number, revisionIds: string[]): Promise<void> {
    const unique = [...new Set(revisionIds)];
    if (!unique.length) return;
    if (unique.length > 100) throw new BadRequestException('Too many annotation source revisions');
    const found = await this.db
      .select({ id: schema.bookFileRevisions.id })
      .from(schema.bookFileRevisions)
      .where(and(eq(schema.bookFileRevisions.bookFileId, bookFileId), inArray(schema.bookFileRevisions.id, unique)));
    if (found.length !== unique.length) throw new NotFoundException('Revision not found for this file');
  }

  private async get(bookFileId: number, revisionId: string) {
    const [revision] = await this.db
      .select()
      .from(schema.bookFileRevisions)
      .where(and(eq(schema.bookFileRevisions.bookFileId, bookFileId), eq(schema.bookFileRevisions.id, revisionId)))
      .limit(1);
    if (!revision) throw new NotFoundException('Revision not found for this file');
    return revision;
  }

  async requireFile(bookFileId: number, libraryId: number) {
    const [file] = await this.db
      .select({ bookId: schema.bookFiles.bookId, currentRevisionId: schema.bookFiles.currentRevisionId })
      .from(schema.bookFiles)
      .innerJoin(schema.books, eq(schema.books.id, schema.bookFiles.bookId))
      .where(and(eq(schema.bookFiles.id, bookFileId), eq(schema.books.libraryId, libraryId)))
      .limit(1);
    if (!file) throw new NotFoundException('Book file not found in this library');
    return file;
  }
}

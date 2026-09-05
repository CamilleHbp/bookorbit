import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, ilike, lt, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolveUploadPath, type FanfictionPreview, type FanfictionSource } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { buildPatternTokens } from '../../common/utils/pattern-tokens.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { DatabaseTransaction } from '../../db/transaction';
import { LibraryService } from '../library/library.service';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { UploadValidatorService } from '../upload/upload-validator.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionJobService } from './fanfiction-job.service';
import { FanfictionProfileService } from './fanfiction-profile.service';
import { ImportFanfictionDto, ListFanfictionSourcesDto, UpdateFanfictionSourceDto } from './dto/fanfiction-source.dto';

const sources = schema.fanfictionSources;
type Job = typeof schema.fanfictionJobs.$inferSelect;

@Injectable()
export class FanfictionSourceService {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly access: FanfictionAccessService,
    private readonly libraries: LibraryService,
    private readonly jobs: FanfictionJobService,
    private readonly profiles: FanfictionProfileService,
    private readonly settings: AppSettingsService,
    private readonly validator: UploadValidatorService,
  ) {}

  async create(libraryId: number, dto: ImportFanfictionDto, user: RequestUser) {
    await this.access.administer(user, libraryId);
    const { library } = await this.libraries.importDestination(libraryId, dto.folderId);
    this.validator.validateFormat('story.epub', library.allowedFormats);
    return this.jobs.importStory(libraryId, dto, user);
  }

  async list(libraryId: number, dto: ListFanfictionSourcesDto, user: RequestUser) {
    await this.access.administer(user, libraryId);
    const before = dto.cursor ? await this.find(libraryId, dto.cursor) : null;
    const rows = await this.db
      .select()
      .from(sources)
      .where(
        and(
          eq(sources.libraryId, libraryId),
          dto.state ? eq(sources.state, dto.state) : sql`${sources.state} <> 'unlinked'`,
          dto.search ? ilike(sources.title, `%${dto.search.replace(/[\\%_]/g, '\\$&')}%`) : undefined,
          before ? or(lt(sources.createdAt, before.createdAt), and(eq(sources.createdAt, before.createdAt), lt(sources.id, before.id))) : undefined,
        ),
      )
      .orderBy(desc(sources.createdAt), desc(sources.id))
      .limit(dto.limit + 1);
    const items = rows.slice(0, dto.limit).map((row) => this.view(row));
    return { items, nextCursor: rows.length > dto.limit ? items.at(-1)!.id : null };
  }

  async folders(libraryId: number, afterId: number, limit: number, user: RequestUser) {
    await this.access.administer(user, libraryId);
    return this.libraries.folderPage(libraryId, afterId, limit);
  }

  async get(libraryId: number, id: string, user: RequestUser) {
    await this.access.administer(user, libraryId);
    return this.view(await this.find(libraryId, id));
  }

  async update(libraryId: number, id: string, dto: UpdateFanfictionSourceDto, user: RequestUser) {
    await this.access.administer(user, libraryId);
    if (dto.profileId) await this.profiles.document(libraryId, dto.profileId, user);
    const previous = await this.find(libraryId, id);
    const state = dto.state ?? previous.state;
    if (state === 'active' && (!previous.bookFileId || previous.state === 'unlinked'))
      throw new ConflictException('This source must finish importing or be linked again before updates can resume');
    const interval = dto.intervalMinutes === undefined ? previous.intervalMinutes : dto.intervalMinutes;
    await this.access.administer(user, libraryId);
    const [updated] = await this.db
      .update(sources)
      .set({
        state,
        ...(dto.profileId !== undefined ? { profileId: dto.profileId } : {}),
        intervalMinutes: interval,
        nextCheckAt: state === 'active' && interval !== null ? sql`now() + (${interval} * interval '1 minute')` : null,
        version: sql`${sources.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(sources.libraryId, libraryId), eq(sources.id, id), eq(sources.version, dto.version)))
      .returning();
    if (!updated) throw new ConflictException('The story source changed; reload it before editing');
    return this.view(updated);
  }

  async reserve(job: Job, preview: FanfictionPreview, user: RequestUser) {
    if (!job.input || job.kind !== 'import') throw new BadRequestException('Missing managed import settings');
    const canonicalUrl = this.canonicalUrl(preview.canonicalUrl);
    if (
      typeof preview.title !== 'string' ||
      !preview.title ||
      preview.title.length > 500 ||
      !Array.isArray(preview.authors) ||
      preview.authors.length > 100 ||
      preview.authors.some((author) => typeof author !== 'string' || author.length > 500) ||
      !Number.isInteger(preview.chapterCount) ||
      preview.chapterCount < 1 ||
      preview.chapterCount > 10_000
    ) {
      throw new BadRequestException('Invalid story preview');
    }
    const canonicalKey = createHash('sha256').update(canonicalUrl).digest('hex');
    const { library } = await this.libraries.importDestination(job.libraryId, job.input.folderId);
    const pattern =
      library.fileNamingPattern ??
      (library.organizationMode === 'book_per_folder' ? await this.settings.getUploadPatternBookPerFolder() : await this.settings.getUploadPattern());
    const filename = this.validator.sanitizeFilename(`${preview.title}.epub`);
    const tokens = buildPatternTokens({
      metadata: preview,
      authors: preview.authors,
      originalStem: filename.slice(0, -5),
      format: 'epub',
      libraryName: library.name,
    });
    const relativePath =
      resolveUploadPath(pattern, tokens, 'epub', { sanitizeForCrossPlatform: await this.settings.isCrossPlatformPathSanitizationEnabled() }) ||
      (library.organizationMode === 'book_per_file' ? filename : join(filename.slice(0, -5), filename));
    return this.db.transaction(async (tx) => {
      await this.jobs.assertOwnership(job, tx);
      await this.access.administer(user, job.libraryId);
      await tx
        .insert(sources)
        .values({
          libraryId: job.libraryId,
          createdBy: job.userId,
          folderId: job.input!.folderId,
          profileId: job.profileId,
          canonicalUrl,
          canonicalKey,
          site: new URL(canonicalUrl).hostname.replace(/^www\./, ''),
          title: preview.title,
          authors: preview.authors,
          chapterCount: preview.chapterCount,
          storyStatus: String(preview.status ?? '').slice(0, 100),
          intervalMinutes: job.input!.intervalMinutes === undefined ? 1440 : job.input!.intervalMinutes,
          importOperationId: randomUUID(),
          relativePath,
        })
        .onConflictDoNothing({ target: [sources.libraryId, sources.canonicalKey] });
      const [source] = await tx
        .select()
        .from(sources)
        .where(and(eq(sources.libraryId, job.libraryId), eq(sources.canonicalKey, canonicalKey)))
        .for('update');
      if (!source || source.canonicalUrl !== canonicalUrl) throw new ConflictException('Story identity is ambiguous');
      if (source.bookFileId || source.state !== 'pending') return { source, owned: false };
      return { source, owned: await this.jobs.bindSource(job, source.id, tx) };
    });
  }

  async assertImportable(job: Job, sourceId: string, transaction: DatabaseTransaction) {
    await this.jobs.assertOwnership(job, transaction);
    const [source] = await transaction
      .select()
      .from(sources)
      .where(and(eq(sources.id, sourceId), eq(sources.libraryId, job.libraryId)))
      .for('update');
    if (!source || source.state !== 'pending') throw new ConflictException('Story import was paused or unlinked');
  }

  async resume(job: Job, user: RequestUser) {
    if (!job.sourceId) return null;
    await this.access.administer(user, job.libraryId);
    return this.db.transaction(async (tx) => {
      await this.jobs.assertOwnership(job, tx);
      const [source] = await tx
        .select()
        .from(sources)
        .where(and(eq(sources.id, job.sourceId!), eq(sources.libraryId, job.libraryId)))
        .for('update');
      if (!source) throw new NotFoundException('Managed story source no longer exists');
      return { source, owned: source.state === 'pending' && (await this.jobs.bindSource(job, source.id, tx)) };
    });
  }

  async completeImport(job: Job, sourceId: string, installed: { bookId: number; bookFileId: number }) {
    return this.db.transaction(async (tx) => {
      await this.assertImportable(job, sourceId, tx);
      const [source] = await tx
        .update(sources)
        .set({
          bookId: installed.bookId,
          bookFileId: installed.bookFileId,
          state: 'active',
          attentionCode: null,
          lastCheckedAt: sql`now()`,
          lastUpdatedAt: sql`now()`,
          updatedAt: sql`now()`,
          nextCheckAt: sql`case when ${sources.intervalMinutes} is null then null else now() + (${sources.intervalMinutes} * interval '1 minute') end`,
          version: sql`${sources.version} + 1`,
        })
        .where(and(eq(sources.id, sourceId), eq(sources.libraryId, job.libraryId)))
        .returning();
      return source!;
    });
  }

  canonicalUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('Invalid canonical story URL');
    }
    if (value.length > 4096 || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
      throw new BadRequestException('Invalid canonical story URL');
    url.hash = '';
    return url.href;
  }

  private async find(libraryId: number, id: string) {
    const [source] = await this.db
      .select()
      .from(sources)
      .where(and(eq(sources.libraryId, libraryId), eq(sources.id, id)))
      .limit(1);
    if (!source) throw new NotFoundException('Story source not found in this library');
    return source;
  }

  private view(row: typeof sources.$inferSelect): FanfictionSource {
    return {
      id: row.id,
      libraryId: row.libraryId,
      folderId: row.folderId,
      profileId: row.profileId,
      bookId: row.bookId,
      bookFileId: row.bookFileId,
      canonicalUrl: row.canonicalUrl,
      site: row.site,
      title: row.title,
      authors: row.authors,
      state: row.state,
      chapterCount: row.chapterCount,
      wordCount: row.wordCount,
      storyStatus: row.storyStatus,
      intervalMinutes: row.intervalMinutes,
      nextCheckAt: row.nextCheckAt?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastUpdatedAt: row.lastUpdatedAt?.toISOString() ?? null,
      attentionCode: row.attentionCode,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

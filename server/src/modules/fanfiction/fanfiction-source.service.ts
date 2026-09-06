import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, ilike, sql } from 'drizzle-orm';
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
import { ImportFanfictionDto, ListFanfictionSourcesDto, UpdateFanfictionSourceDto, RollbackFanfictionSourceDto } from './dto/fanfiction-source.dto';
import { ManagedTagService } from '../metadata/managed-tag.service';
import { recordFanfictionActivity } from './fanfiction-activity';

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
    private readonly managedTags: ManagedTagService,
  ) {}

  async create(libraryId: number, dto: ImportFanfictionDto, user: RequestUser) {
    await this.access.administer(user, libraryId);
    const { library } = await this.libraries.importDestination(libraryId, dto.folderId);
    this.validator.validateFormat('story.epub', library.allowedFormats);
    return this.jobs.importStory(libraryId, dto, user);
  }

  async check(libraryId: number, id: string, kind: 'update' | 'refresh', idempotencyKey: string, user: RequestUser) {
    await this.access.administer(user, libraryId);
    const source = await this.find(libraryId, id);
    if (source.attentionCode === 'destination_profile_required')
      throw new ConflictException('Choose a destination library profile before checking this story');
    return this.jobs.updateStory(source, kind, idempotencyKey, user);
  }

  async rollback(libraryId: number, id: string, dto: RollbackFanfictionSourceDto, user: RequestUser) {
    await this.access.administer(user, libraryId);
    return this.jobs.updateStory(await this.find(libraryId, id), 'rollback', dto.idempotencyKey, user, false, dto);
  }

  async updateContext(job: Job) {
    return this.db.transaction((tx) => this.assertUpdatable(job, tx));
  }

  async assertUpdatable(job: Job, tx: DatabaseTransaction) {
    await this.jobs.assertOwnership(job, tx);
    if (!job.sourceId) throw new BadRequestException('Update has no managed story source');
    const [source] = await tx
      .select()
      .from(sources)
      .where(and(eq(sources.id, job.sourceId), eq(sources.libraryId, job.libraryId)))
      .for('update');
    if (
      !source ||
      !source.bookFileId ||
      (job.kind !== 'rollback' && source.attentionCode === 'destination_profile_required') ||
      source.version !== job.sourceVersion ||
      source.profileId !== job.profileId ||
      !(job.kind === 'rollback' ? ['active', 'paused', 'configuration_blocked', 'review_required'] : ['active', 'paused']).includes(source.state) ||
      (job.scheduled && source.state !== 'active')
    )
      throw new ConflictException({ message: 'Story source settings changed before publication', errorCode: 'configuration_blocked' });
    return source;
  }

  async expectRevision(job: Job, revisionId: string): Promise<string> {
    return this.db.transaction(async (tx) => {
      await this.assertUpdatable(job, tx);
      const [row] = await tx
        .update(schema.fanfictionJobs)
        .set({ expectedRevisionId: sql`coalesce(${schema.fanfictionJobs.expectedRevisionId}, ${revisionId}::uuid)` })
        .where(eq(schema.fanfictionJobs.id, job.id))
        .returning({ revisionId: schema.fanfictionJobs.expectedRevisionId });
      return row.revisionId!;
    });
  }

  async stageUpdatePreview(job: Job, preview: FanfictionPreview): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.assertUpdatable(job, tx);
      await tx.update(schema.fanfictionJobs).set({ result: { preview } }).where(eq(schema.fanfictionJobs.id, job.id));
    });
  }

  async completeUpdate(job: Job, result: NonNullable<import('@bookorbit/types').FanfictionJob['result']>, preview?: FanfictionPreview) {
    return this.db.transaction(async (tx) => {
      const source = await this.assertUpdatable(job, tx);
      if (preview && source.bookId)
        await this.managedTags.sync(tx, source.bookId, { key: `fanfiction:${source.id}`, libraryId: job.libraryId }, preview.tags);
      await tx
        .update(sources)
        .set({
          ...(preview ? { title: preview.title, authors: preview.authors, chapterCount: preview.chapterCount, storyStatus: preview.status } : {}),
          attentionCode: null,
          lastCheckedAt: sql`now()`,
          ...(!result.noChange ? { lastUpdatedAt: sql`now()` } : {}),
          nextCheckAt: sql`case when ${sources.state} <> 'active' or ${sources.intervalMinutes} is null then null else now() + (${sources.intervalMinutes} * interval '1 minute') end`,
          updatedAt: sql`now()`,
          version: sql`${sources.version} + 1`,
        })
        .where(and(eq(sources.id, job.sourceId!), eq(sources.libraryId, job.libraryId)));
      await tx.update(schema.fanfictionJobs).set({ result }).where(eq(schema.fanfictionJobs.id, job.id));
      if (!result.noChange)
        await recordFanfictionActivity(tx, {
          libraryId: job.libraryId,
          userId: job.userId,
          sourceId: source.id,
          jobId: job.id,
          eventKey: `${job.id}:updated`,
          kind: 'updated',
          title: preview?.title ?? source.title,
          bookId: source.bookId,
          revisionId: result.revisionId,
        });
      return result;
    });
  }

  async completeRollback(job: Job, revisionId: string) {
    return this.db.transaction(async (tx) => {
      const source = await this.assertUpdatable(job, tx);
      await tx
        .update(sources)
        .set({
          state: 'paused',
          nextCheckAt: null,
          attentionCode: source.attentionCode === 'destination_profile_required' ? source.attentionCode : null,
          lastUpdatedAt: sql`now()`,
          updatedAt: sql`now()`,
          version: sql`${sources.version} + 1`,
        })
        .where(eq(sources.id, source.id));
      const result = { sourceId: source.id, bookId: source.bookId!, bookFileId: source.bookFileId!, revisionId };
      await tx.update(schema.fanfictionJobs).set({ result }).where(eq(schema.fanfictionJobs.id, job.id));
      await recordFanfictionActivity(tx, {
        libraryId: job.libraryId,
        userId: job.userId,
        sourceId: source.id,
        jobId: job.id,
        eventKey: `${job.id}:rolled_back`,
        kind: 'rolled_back',
        title: source.title,
        bookId: source.bookId,
        revisionId,
      });
      return result;
    });
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
          dto.bookId ? eq(sources.bookId, dto.bookId) : undefined,
          dto.state ? eq(sources.state, dto.state) : sql`${sources.state} <> 'unlinked'`,
          dto.search ? ilike(sources.title, `%${dto.search.replace(/[\\%_]/g, '\\$&')}%`) : undefined,
          before
            ? sql`(${sources.createdAt}, ${sources.id}) < (select ${sources.createdAt}, ${sources.id} from ${sources} where ${sources.id} = ${before.id} and ${sources.libraryId} = ${libraryId})`
            : undefined,
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
    const needsProfile = previous.attentionCode === 'destination_profile_required';
    if (needsProfile && state === 'active' && dto.profileId === undefined)
      throw new ConflictException('Choose a destination library profile before resuming updates');
    if (state === 'active' && (!previous.bookFileId || previous.state === 'unlinked'))
      throw new ConflictException('This source must finish importing or be linked again before updates can resume');
    const interval = dto.intervalMinutes === undefined ? previous.intervalMinutes : dto.intervalMinutes;
    await this.access.administer(user, libraryId);
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(sources)
        .set({
          state,
          ...(needsProfile && dto.profileId !== undefined ? { attentionCode: null } : {}),
          ...(dto.profileId !== undefined ? { profileId: dto.profileId } : {}),
          intervalMinutes: interval,
          nextCheckAt: state === 'active' && interval !== null ? sql`now() + (${interval} * interval '1 minute')` : null,
          version: sql`${sources.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(sources.libraryId, libraryId), eq(sources.id, id), eq(sources.version, dto.version)))
        .returning();
      if (!updated) throw new ConflictException('The story source changed; reload it before editing');
      if (updated.state === 'unlinked' && updated.bookId)
        await this.managedTags.release(tx, updated.bookId, { key: `fanfiction:${updated.id}`, libraryId });
      return this.view(updated);
    });
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
      await recordFanfictionActivity(tx, {
        libraryId: job.libraryId,
        userId: job.userId,
        sourceId,
        jobId: job.id,
        eventKey: `${job.id}:imported`,
        kind: 'imported',
        title: source!.title,
        bookId: installed.bookId,
      });
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

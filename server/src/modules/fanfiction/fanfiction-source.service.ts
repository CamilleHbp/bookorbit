import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolveUploadPath, type FanfictionPreview, type FanfictionSource, type FanfictionExistingStoryConflict } from '@bookorbit/types';
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
import { ManagedMetadataService } from '../metadata/managed-metadata.service';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';
import { ManagedTagService } from '../metadata/managed-tag.service';
import { recordFanfictionActivity } from './fanfiction-activity';
import { validateFanfictionPreview } from './fanfiction-preview';
import { changedStoryMetadata } from './fanfiction-metadata-review';
import type { FanfictionMetadataReviewView, FanfictionMetadataResolution } from '@bookorbit/types';

const sources = schema.fanfictionSources;
type Job = typeof schema.fanfictionJobs.$inferSelect;

@Injectable()
export class FanfictionSourceService {
  private readonly logger = new Logger(FanfictionSourceService.name);
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly access: FanfictionAccessService,
    private readonly libraries: LibraryService,
    private readonly jobs: FanfictionJobService,
    private readonly profiles: FanfictionProfileService,
    private readonly settings: AppSettingsService,
    private readonly validator: UploadValidatorService,
    private readonly managedTags: ManagedTagService,
    private readonly managedMetadata: ManagedMetadataService,
    private readonly catalog: RevisionCatalogService,
  ) {}

  async create(libraryId: number, dto: ImportFanfictionDto, user: RequestUser) {
    await this.access.administer(user, libraryId);
    const canonicalKey = createHash('sha256').update(this.canonicalUrl(dto.url)).digest('hex');
    const [existing] = await this.db
      .select({ id: sources.id, title: sources.title, bookFileId: sources.bookFileId })
      .from(sources)
      .where(and(eq(sources.libraryId, libraryId), eq(sources.canonicalKey, canonicalKey)))
      .limit(1);
    if (existing?.bookFileId)
      throw new ConflictException({
        message: 'This story is already in your library',
        errorCode: 'story_exists',
        errorMeta: { id: existing.id, title: existing.title },
      } satisfies FanfictionExistingStoryConflict & { message: string });
    const { library } = await this.libraries.importDestination(libraryId, dto.folderId);
    this.validator.validateFormat('story.epub', library.allowedFormats);
    return this.jobs.importStory(libraryId, dto, user);
  }

  async metadataReview(libraryId: number, id: string, user: RequestUser): Promise<FanfictionMetadataReviewView | null> {
    await this.access.administer(user, libraryId);
    const source = await this.find(libraryId, id);
    if (source.attentionCode !== 'metadata_review_required' || source.state === 'unlinked') return null;
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select({ id: schema.fanfictionJobs.id, result: schema.fanfictionJobs.result })
        .from(schema.fanfictionJobs)
        .where(
          and(
            eq(schema.fanfictionJobs.sourceId, id),
            eq(schema.fanfictionJobs.libraryId, libraryId),
            sql`${schema.fanfictionJobs.result}->'metadataReview' is not null`,
          ),
        )
        .orderBy(desc(schema.fanfictionJobs.createdAt), desc(schema.fanfictionJobs.id))
        .limit(1);
      if (!job?.result?.metadataReview || !source.bookId) return null;
      const snapshot = await this.managedMetadata.snapshot(tx, source.bookId, libraryId);
      return { jobId: job.id, review: { ...job.result.metadataReview, ...snapshot } };
    });
  }

  async resolveMetadata(libraryId: number, id: string, dto: FanfictionMetadataResolution, user: RequestUser) {
    await this.access.administer(user, libraryId);
    const startedAt = Date.now();
    this.logger.log(`[fanfiction.metadata_review] [start] libraryId=${libraryId} sourceId=${id} jobId=${dto.jobId} - resolving story metadata`);
    return this.db
      .transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(schema.fanfictionJobs)
          .where(and(eq(schema.fanfictionJobs.id, dto.jobId), eq(schema.fanfictionJobs.sourceId, id), eq(schema.fanfictionJobs.libraryId, libraryId)))
          .for('update');
        const review = job?.result?.metadataReview;
        if (!review || !['succeeded', 'no_change', 'cancelled'].includes(job.state))
          throw new ConflictException('Refresh the metadata review before saving');
        if (!job.result?.bookFileId || !job.result.revisionId) throw new ConflictException('The review has no installed story');
        const file = await this.catalog.lockCurrent(tx, job.result.bookFileId, libraryId, job.result.revisionId);
        const [source] = await tx
          .select()
          .from(sources)
          .where(and(eq(sources.id, id), eq(sources.libraryId, libraryId)))
          .for('update');
        if (
          !source ||
          source.state !== 'review_required' ||
          source.attentionCode !== 'metadata_review_required' ||
          source.bookId !== file.bookId ||
          source.bookFileId !== job.result.bookFileId
        )
          throw new ConflictException('The story source changed; reload it before editing');
        const snapshot = await this.managedMetadata.snapshot(tx, file.bookId, libraryId);
        if (snapshot.fingerprint !== dto.fingerprint) throw new ConflictException('Book metadata changed; refresh the review before saving');
        const fields = review.fields.filter((field) => dto[field] !== 'keep');
        if (fields.some((field) => snapshot.lockedFields.includes(field)))
          throw new ConflictException('Unlock the selected metadata fields before saving');
        const incoming = { ...review.incoming, tags: [...new Set([...snapshot.current.tags, ...review.incoming.tags])] };
        await this.managedMetadata.apply(tx, file.bookId, { key: `fanfiction:${id}`, libraryId }, incoming, fields);
        const result = { ...job.result };
        delete result.metadataReview;
        await tx
          .update(schema.fanfictionJobs)
          .set({ result, updatedAt: sql`now()` })
          .where(eq(schema.fanfictionJobs.id, job.id));
        await tx
          .update(sources)
          .set({
            state: review.previousState,
            attentionCode: null,
            nextCheckAt:
              review.previousState === 'active' && source.intervalMinutes !== null
                ? sql`now() + (${source.intervalMinutes} * interval '1 minute')`
                : null,
            version: sql`${sources.version} + 1`,
            updatedAt: sql`now()`,
          })
          .where(eq(sources.id, id));
        return { resolved: true };
      })
      .then((result) => {
        this.logger.log(
          `[fanfiction.metadata_review] [end] libraryId=${libraryId} sourceId=${id} jobId=${dto.jobId} durationMs=${Date.now() - startedAt} resolved=true - story metadata reviewed`,
        );
        return result;
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `[fanfiction.metadata_review] [fail] libraryId=${libraryId} sourceId=${id} jobId=${dto.jobId} durationMs=${Date.now() - startedAt} errorClass=MetadataReviewError error="metadata review rejected" - story metadata could not be reviewed`,
        );
        throw error;
      });
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
      (!['rollback', 'replacement'].includes(job.kind) && source.attentionCode === 'destination_profile_required') ||
      source.version !== job.sourceVersion ||
      source.profileId !== job.profileId ||
      !(
        ['rollback', 'replacement'].includes(job.kind) ? ['active', 'paused', 'configuration_blocked', 'review_required'] : ['active', 'paused']
      ).includes(source.state) ||
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
    if (preview) preview = validateFanfictionPreview(preview);
    return this.db.transaction(async (tx) => {
      if (!result.bookFileId || !result.revisionId) throw new BadRequestException('A completed update requires its installed revision');
      const file = await this.catalog.lockCurrent(tx, result.bookFileId, job.libraryId, result.revisionId);
      const source = await this.assertUpdatable(job, tx);
      if (source.bookFileId !== result.bookFileId || source.bookId !== file.bookId) throw new ConflictException('The managed book identity changed');
      if (preview && source.bookId) {
        const snapshot = await this.managedMetadata.snapshot(tx, source.bookId, job.libraryId);
        const [previous] = await tx
          .select({ result: schema.fanfictionJobs.result })
          .from(schema.fanfictionJobs)
          .where(
            and(
              eq(schema.fanfictionJobs.sourceId, source.id),
              eq(schema.fanfictionJobs.libraryId, job.libraryId),
              sql`${schema.fanfictionJobs.id} <> ${job.id}`,
              sql`${schema.fanfictionJobs.result}->>'revisionId' is not null`,
            ),
          )
          .orderBy(desc(schema.fanfictionJobs.createdAt), desc(schema.fanfictionJobs.id))
          .limit(1);
        const fields = changedStoryMetadata(snapshot.current, preview, previous?.result?.preview);
        result = {
          ...result,
          preview,
          ...(fields.length
            ? {
                metadataReview: {
                  ...snapshot,
                  incoming: { title: preview.title, description: preview.description, authors: preview.authors, tags: preview.tags },
                  fields,
                  previousState: source.state === 'paused' ? 'paused' : 'active',
                },
              }
            : {}),
        };
      }
      await tx
        .update(sources)
        .set({
          ...(preview
            ? {
                title: preview.title,
                authors: preview.authors,
                chapterCount: preview.chapterCount,
                wordCount: preview.wordCount ?? null,
                storyStatus: preview.status,
              }
            : {}),
          ...(job.kind === 'replacement' && result.replacement
            ? {
                title: result.replacement.title,
                authors: result.replacement.authors,
                chapterCount: result.replacement.chapterCount,
                state: 'paused' as const,
              }
            : {}),
          ...(result.metadataReview ? { state: 'review_required' as const } : {}),
          attentionCode: result.metadataReview
            ? 'metadata_review_required'
            : job.kind === 'replacement' && source.attentionCode === 'destination_profile_required'
              ? source.attentionCode
              : null,
          lastCheckedAt: job.kind === 'replacement' ? source.lastCheckedAt : sql`now()`,
          ...(!result.noChange ? { lastUpdatedAt: sql`now()` } : {}),
          nextCheckAt:
            job.kind === 'replacement' || result.metadataReview
              ? null
              : sql`case when ${sources.state} <> 'active' or ${sources.intervalMinutes} is null then null else now() + (${sources.intervalMinutes} * interval '1 minute') end`,
          updatedAt: sql`now()`,
          version: sql`${sources.version} + 1`,
        })
        .where(and(eq(sources.id, job.sourceId!), eq(sources.libraryId, job.libraryId)));
      await tx.update(schema.fanfictionJobs).set({ result }).where(eq(schema.fanfictionJobs.id, job.id));
      if (!result.noChange || result.metadataReview)
        await recordFanfictionActivity(tx, {
          libraryId: job.libraryId,
          userId: job.userId,
          sourceId: source.id,
          jobId: job.id,
          eventKey: `${job.id}:updated`,
          kind: result.metadataReview ? 'attention' : 'updated',
          errorCode: result.metadataReview ? 'metadata_review_required' : null,
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
    if (previous.attentionCode === 'metadata_review_required' && dto.state && dto.state !== 'unlinked')
      throw new ConflictException('Review story metadata before resuming updates');
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

  async setSchedule(tx: DatabaseTransaction, source: typeof sources.$inferSelect, intervalMinutes: number | null) {
    if (intervalMinutes !== null && (!Number.isInteger(intervalMinutes) || intervalMinutes < 60 || intervalMinutes > 525600))
      throw new BadRequestException('Invalid story update interval');
    if (source.state === 'unlinked') throw new ConflictException('The story source is unlinked');
    if (source.intervalMinutes === intervalMinutes) return;
    const changed = await tx
      .update(sources)
      .set({
        intervalMinutes,
        nextCheckAt: source.state === 'active' && intervalMinutes !== null ? sql`now() + (${intervalMinutes} * interval '1 minute')` : null,
        version: sql`${sources.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(sources.id, source.id), eq(sources.libraryId, source.libraryId), eq(sources.version, source.version)))
      .returning({ id: sources.id });
    if (!changed.length) throw new ConflictException('The story source changed before scheduling');
  }

  async reserve(job: Job, preview: FanfictionPreview, user: RequestUser) {
    if (!job.input || job.kind !== 'import') throw new BadRequestException('Missing managed import settings');
    preview = validateFanfictionPreview(preview);
    const canonicalUrl = this.canonicalUrl(preview.canonicalUrl);
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
          wordCount: preview.wordCount ?? null,
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
    return source;
  }

  async recordImportMetadata(job: Job, sourceId: string, value: FanfictionPreview, user: RequestUser) {
    const preview = validateFanfictionPreview(value);
    await this.access.administer(user, job.libraryId);
    const startedAt = Date.now();
    this.logger.log(
      `[fanfiction.import_metadata] [start] libraryId=${job.libraryId} sourceId=${sourceId} jobId=${job.id} - retaining downloaded story metadata`,
    );
    try {
      await this.db.transaction(async (tx) => {
        const source = await this.assertImportable(job, sourceId, tx);
        if (this.canonicalUrl(preview.canonicalUrl) !== source.canonicalUrl || preview.chapterCount < source.chapterCount)
          throw new BadRequestException({ message: 'The story identity or chapter count changed before import', errorCode: 'review_required' });
        await tx
          .update(sources)
          .set({
            title: preview.title,
            authors: preview.authors,
            chapterCount: preview.chapterCount,
            wordCount: preview.wordCount ?? null,
            storyStatus: preview.status,
            updatedAt: sql`now()`,
            version: sql`${sources.version} + 1`,
          })
          .where(and(eq(sources.id, sourceId), eq(sources.libraryId, job.libraryId)));
      });
      this.logger.log(
        `[fanfiction.import_metadata] [end] libraryId=${job.libraryId} sourceId=${sourceId} jobId=${job.id} durationMs=${Date.now() - startedAt} - downloaded metadata retained`,
      );
    } catch (error) {
      this.logger.warn(
        `[fanfiction.import_metadata] [fail] libraryId=${job.libraryId} sourceId=${sourceId} jobId=${job.id} durationMs=${Date.now() - startedAt} errorClass=ImportMetadataError error="downloaded metadata rejected" - metadata could not be retained`,
      );
      throw error;
    }
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

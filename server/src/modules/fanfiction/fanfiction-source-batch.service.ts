import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, exists, gt, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import type { FanfictionJob, FanfictionProfileSummary, FanfictionSourceBatchStatus, FanfictionSourceSelection } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { DatabaseTransaction } from '../../db/transaction';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionJobService } from './fanfiction-job.service';
import { FanfictionSourceService } from './fanfiction-source.service';
import { FanfictionProfileService } from './fanfiction-profile.service';
import { FanfictionSourceBatchScopeDto, SelectFanfictionSourcesDto } from './dto/fanfiction-source-batch.dto';

const jobs = schema.fanfictionJobs;
const sources = schema.fanfictionSources;
const failures = schema.fanfictionSourceBatchFailures;
const items = schema.fanfictionSourceBatchItems;

@Injectable()
export class FanfictionSourceBatchService {
  private readonly logger = new Logger(FanfictionSourceBatchService.name);
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly access: FanfictionAccessService,
    private readonly jobs: FanfictionJobService,
    private readonly sources: FanfictionSourceService,
    private readonly profiles: FanfictionProfileService,
  ) {}

  async repairProfile(profile: FanfictionProfileSummary, user: RequestUser) {
    return this.start(profile.libraryId, { action: 'retry', allMatching: true, idempotencyKey: randomUUID() }, user, profile);
  }

  private repairFilter(profileId?: string, roots: string[] = []) {
    if (!profileId) return undefined;
    const website = or(
      ...roots.map(
        (root) =>
          sql`(${sources.canonicalUrl} = ${root} or starts_with(${sources.canonicalUrl}, ${root + '/'}) or starts_with(${sources.canonicalUrl}, ${root + '?'}) or starts_with(${sources.canonicalUrl}, ${root + '#'}))`,
      ),
    );
    return and(
      ne(sources.state, 'unlinked'),
      inArray(sources.attentionCode, [
        'authentication_required',
        'access_denied',
        'source_not_found',
        'source_failed',
        'source_unavailable',
        'source_rate_limited',
        'download_timeout',
      ]),
      or(eq(sources.profileId, profileId), website ? and(isNull(sources.profileId), website) : undefined),
    );
  }

  async scope(libraryId: number, dto: FanfictionSourceBatchScopeDto, user: RequestUser) {
    await this.access.administer(user, libraryId);
    const match =
      and(dto.state ? eq(sources.state, dto.state) : undefined, dto.search?.trim() ? ilike(sources.title, `%${dto.search.trim()}%`) : undefined) ??
      sql`true`;
    const [counts] = await this.db
      .select({ total: sql<number>`count(*)::int`, matching: sql<number>`count(*) filter (where ${match})::int` })
      .from(sources)
      .where(eq(sources.libraryId, libraryId));
    return counts;
  }

  private async ownedBatch(libraryId: number, jobId: string, user: RequestUser) {
    await this.access.administer(user, libraryId);
    const [job] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.libraryId, libraryId), eq(jobs.id, jobId), eq(jobs.kind, 'source_batch')))
      .limit(1);
    if (!job) throw new NotFoundException('Story selection not found');
    if (job.userId !== user.id && !user.isSuperuser) throw new ForbiddenException('This story check belongs to another user');
    return job;
  }

  async status(libraryId: number, jobId: string, user: RequestUser): Promise<FanfictionSourceBatchStatus> {
    const batch = await this.ownedBatch(libraryId, jobId, user);
    const job = await this.jobs.get(libraryId, jobId, user);
    const trackingAvailable = batch.sourceSelection?.tracksOutcomes === true;
    const [counts] = await this.db
      .select({
        tracked: sql<number>`count(*)::int`,
        running: sql<number>`count(*) filter (where ${items.errorCode} is null and ${jobs.state} in ('queued', 'running'))::int`,
        updated: sql<number>`count(*) filter (where ${items.errorCode} is null and ${jobs.state} = 'succeeded' and coalesce((${jobs.result}->>'noChange')::boolean, false) = false)::int`,
        unchanged: sql<number>`count(*) filter (where ${items.errorCode} is null and (${jobs.state} = 'no_change' or (${jobs.state} = 'succeeded' and (${jobs.result}->>'noChange')::boolean = true)))::int`,
      })
      .from(items)
      .leftJoin(jobs, eq(jobs.id, items.childJobId))
      .where(and(eq(items.batchId, jobId), eq(items.userId, batch.userId)));
    const scheduling = batch.sourceSelection?.action === 'schedule';
    const needsAttention = scheduling ? (job.result?.selection?.failed ?? 0) : counts.tracked - counts.running - counts.updated - counts.unchanged;
    const checked = scheduling ? (job.result?.selection?.processed ?? 0) : counts.updated + counts.unchanged + needsAttention;
    const selecting = ['queued', 'running'].includes(job.state);
    const total = batch.sourceSelection?.total ?? null;
    return {
      job,
      total,
      checked,
      updated: counts.updated,
      unchanged: counts.unchanged,
      needsAttention,
      running: counts.running,
      waiting: selecting && total !== null ? Math.max(0, total - counts.tracked) : 0,
      finished: !selecting && counts.running === 0,
      trackingAvailable,
    };
  }

  async start(libraryId: number, dto: SelectFanfictionSourcesDto, user: RequestUser, repair?: FanfictionProfileSummary) {
    await this.access.administer(user, libraryId);
    if (Boolean(dto.ids?.length) === Boolean(dto.allMatching)) throw new BadRequestException('Choose selected stories or all matching stories');
    if (dto.action === 'schedule' && dto.intervalMinutes === undefined) throw new BadRequestException('Choose an update schedule');
    if (dto.action !== 'schedule' && dto.intervalMinutes !== undefined)
      throw new BadRequestException('A schedule is only valid for a schedule action');
    const ids = dto.ids ? [...new Set(dto.ids)].sort() : null;
    const input = {
      ids,
      search: dto.search?.trim() || null,
      state: dto.state ?? null,
      action: dto.action,
      intervalMinutes: dto.intervalMinutes ?? null,
      ...(repair ? { repairProfileId: repair.id, repairRootUrls: repair.rootUrls ?? [] } : {}),
    };
    const reuse = (existing: typeof jobs.$inferSelect | undefined) => {
      const previous = existing?.sourceSelection;
      if (
        existing?.kind !== 'source_batch' ||
        !previous ||
        previous.action !== input.action ||
        previous.search !== input.search ||
        previous.state !== input.state ||
        previous.intervalMinutes !== input.intervalMinutes ||
        previous.repairProfileId !== input.repairProfileId ||
        JSON.stringify(previous.ids) !== JSON.stringify(ids)
      )
        throw new ConflictException('Operation identity was reused with different input');
      return existing.id;
    };
    const jobId = await this.db.transaction(async (tx) => {
      const previous = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.libraryId, libraryId), eq(jobs.userId, user.id), eq(jobs.idempotencyKey, dto.idempotencyKey)))
        .limit(1);
      if (previous[0]) return reuse(previous[0]);
      if (ids) {
        const present = await tx
          .select({ id: sources.id })
          .from(sources)
          .where(and(eq(sources.libraryId, libraryId), inArray(sources.id, ids)))
          .limit(100);
        if (present.length !== ids.length) throw new NotFoundException('Some selected sources are not available in this library');
      }
      const {
        rows: [{ cutoff }],
      } = await tx.execute<{ cutoff: string }>(sql`select to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as cutoff`);
      const [{ total }] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(sources)
        .where(
          and(
            eq(sources.libraryId, libraryId),
            this.repairFilter(repair?.id, repair?.rootUrls),
            sql`${sources.createdAt} <= ${cutoff}::timestamptz`,
            ids
              ? inArray(sources.id, ids)
              : and(input.state ? eq(sources.state, input.state) : undefined, input.search ? ilike(sources.title, `%${input.search}%`) : undefined),
          ),
        );
      const [inserted] = await tx
        .insert(jobs)
        .values({
          libraryId,
          userId: user.id,
          tokenVersion: user.tokenVersion,
          idempotencyKey: dto.idempotencyKey,
          kind: 'source_batch',
          profileId: repair?.id,
          site: `local-library-${libraryId}`,
          url: '',
          sourceSelection: { ...input, cutoff, total, tracksOutcomes: true, cursor: null, processed: 0, failed: 0 },
          result: { selection: { tracked: true, processed: 0, failed: 0, finished: false, action: dto.action } },
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) return inserted.id;
      const [existing] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.libraryId, libraryId), eq(jobs.userId, user.id), eq(jobs.idempotencyKey, dto.idempotencyKey)))
        .limit(1);
      return reuse(existing);
    });
    return this.jobs.get(libraryId, jobId, user);
  }

  async listFailures(libraryId: number, jobId: string, cursor: string | undefined, limit: number, user: RequestUser) {
    const job = await this.ownedBatch(libraryId, jobId, user);
    if (job.sourceSelection?.tracksOutcomes) {
      const rows = await this.db
        .select({
          sourceId: items.sourceId,
          jobId: items.childJobId,
          title: sources.title,
          bookId: sources.bookId,
          site: sources.site,
          profileId: sources.profileId,
          errorCode: sql<string>`coalesce(${items.errorCode}, ${jobs.errorCode}, ${sources.attentionCode}, 'source_batch_item_failed')`,
        })
        .from(items)
        .innerJoin(sources, eq(sources.id, items.sourceId))
        .leftJoin(jobs, eq(jobs.id, items.childJobId))
        .where(
          and(
            eq(items.batchId, jobId),
            eq(items.userId, job.userId),
            eq(sources.libraryId, libraryId),
            cursor ? gt(items.sourceId, cursor) : undefined,
            sql`(${items.errorCode} is not null or ${jobs.state} in ('failed', 'cancelled', 'review_required', 'configuration_blocked') or (${items.childJobId} is null and ${job.sourceSelection.action} <> 'schedule'))`,
          ),
        )
        .orderBy(asc(items.sourceId))
        .limit(limit + 1);
      return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].sourceId : null };
    }
    const rows = await this.db
      .select({ sourceId: failures.sourceId, title: sources.title, errorCode: failures.errorCode })
      .from(failures)
      .innerJoin(sources, eq(sources.id, failures.sourceId))
      .where(and(eq(failures.jobId, jobId), eq(sources.libraryId, libraryId), cursor ? gt(failures.sourceId, cursor) : undefined))
      .orderBy(asc(failures.sourceId))
      .limit(limit + 1);
    const pageItems = rows.slice(0, limit);
    return { items: pageItems, nextCursor: rows.length > limit ? pageItems.at(-1)!.sourceId : null };
  }

  async run(
    job: typeof jobs.$inferSelect,
    user: RequestUser,
    authorize: () => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<FanfictionJob['result']> {
    if (!job.sourceSelection) throw new BadRequestException('Story selection has no saved cutoff');
    let selection = { ...job.sourceSelection };
    const startedAt = Date.now();
    this.logger.log(
      `[fanfiction.source_batch] [start] libraryId=${job.libraryId} jobId=${job.id} action=${selection.action} - processing saved story selection`,
    );
    try {
      await authorize();
      const batch = await this.db
        .select()
        .from(sources)
        .where(
          and(
            eq(sources.libraryId, job.libraryId),
            this.repairFilter(selection.repairProfileId, selection.repairRootUrls),
            sql`${sources.createdAt} <= ${selection.cutoff}::timestamptz`,
            selection.cursor ? gt(sources.id, selection.cursor) : undefined,
            selection.retryFailedOnly
              ? exists(
                  this.db
                    .select({ sourceId: failures.sourceId })
                    .from(failures)
                    .where(and(eq(failures.jobId, job.id), eq(failures.sourceId, sources.id))),
                )
              : selection.ids
                ? inArray(sources.id, selection.ids)
                : and(
                    selection.state ? eq(sources.state, selection.state) : undefined,
                    selection.search ? ilike(sources.title, `%${selection.search}%`) : undefined,
                  ),
          ),
        )
        .orderBy(asc(sources.id))
        .limit(100);
      const matches = selection.repairProfileId
        ? await this.profiles.matchMany(
            job.libraryId,
            batch.filter((source) => !source.profileId).map((source) => source.canonicalUrl),
            user,
          )
        : null;
      for (const source of batch) {
        if (signal.aborted) throw new ConflictException('Story selection was cancelled');
        try {
          selection = await this.db.transaction(async (tx) => {
            await this.jobs.assertOwnership(job, tx);
            await authorize();
            const child = await this.apply(tx, job, source, selection, user, matches?.get(source.canonicalUrl)?.profile?.id);
            return this.checkpoint(tx, job, source.id, selection, null, child?.id);
          });
        } catch (error) {
          if (!(error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException)) throw error;
          selection = await this.db.transaction(async (tx) => {
            await this.jobs.assertOwnership(job, tx);
            await authorize();
            const response = error.getResponse();
            const code =
              typeof response === 'object' && 'errorCode' in response
                ? String(response.errorCode)
                : (source.attentionCode ?? 'source_batch_item_failed');
            return this.checkpoint(tx, job, source.id, selection, code);
          });
        }
        if (Date.now() - startedAt >= 20_000) break;
      }
      const finished = !batch.length || (batch.length < 100 && selection.cursor === batch.at(-1)!.id);
      this.logger.log(
        `[fanfiction.source_batch] [end] libraryId=${job.libraryId} jobId=${job.id} durationMs=${Date.now() - startedAt} processed=${selection.processed} failed=${selection.failed} finished=${finished} - story selection checkpoint saved`,
      );
      return {
        selection: {
          tracked: selection.tracksOutcomes,
          processed: selection.processed,
          failed: selection.failed,
          finished,
          action: selection.action,
        },
      };
    } catch (error) {
      this.logger.warn(
        `[fanfiction.source_batch] [fail] libraryId=${job.libraryId} jobId=${job.id} durationMs=${Date.now() - startedAt} errorClass=SourceBatchError error="story selection interrupted" - saved selection remains resumable`,
      );
      throw error;
    }
  }

  private async apply(
    tx: DatabaseTransaction,
    job: typeof jobs.$inferSelect,
    source: typeof sources.$inferSelect,
    selection: FanfictionSourceSelection,
    user: RequestUser,
    matchedProfileId?: string,
  ) {
    if (selection.repairProfileId) {
      if (!source.profileId && matchedProfileId !== selection.repairProfileId)
        throw new ConflictException('Choose the website login before retrying');
      const [current] = await tx
        .select()
        .from(sources)
        .where(and(eq(sources.id, source.id), eq(sources.libraryId, job.libraryId)))
        .for('update');
      if (!current || current.version !== source.version || current.state === 'unlinked')
        throw new ConflictException('Story changed before retrying');
      const [active] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.sourceId, source.id), inArray(jobs.state, ['queued', 'running'])))
        .limit(1);
      if (active) return active;
      if (current.bookFileId) {
        const [ready] = await tx
          .update(sources)
          .set({ state: current.state === 'configuration_blocked' ? 'paused' : current.state, attentionCode: null, updatedAt: sql`now()` })
          .where(eq(sources.id, current.id))
          .returning();
        return this.jobs.updateStory(ready, 'update', randomUUID(), user, false, undefined, tx);
      }
    }
    if (selection.action === 'schedule') {
      await this.sources.setSchedule(tx, source, selection.intervalMinutes);
      return;
    }
    if (selection.action === 'update' || selection.action === 'refresh') {
      return this.jobs.updateStory(source, selection.action, randomUUID(), user, false, undefined, tx);
    }
    const [previous] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.libraryId, job.libraryId),
          eq(jobs.sourceId, source.id),
          inArray(jobs.kind, ['import', 'update', 'refresh', 'rollback', 'replacement']),
        ),
      )
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(1);
    if (previous) return this.jobs.retry(job.libraryId, previous.id, user, tx);
    throw new BadRequestException('No previous update is available to retry');
  }

  private async checkpoint(
    tx: DatabaseTransaction,
    job: typeof jobs.$inferSelect,
    sourceId: string,
    selection: FanfictionSourceSelection,
    errorCode: string | null,
    childJobId?: string,
  ) {
    const jobId = job.id;
    await tx
      .insert(items)
      .values({ batchId: jobId, sourceId, userId: job.userId, childJobId: childJobId ?? null, errorCode })
      .onConflictDoUpdate({ target: [items.batchId, items.sourceId], set: { childJobId: childJobId ?? null, errorCode } });
    const next = { ...selection, cursor: sourceId, processed: selection.processed + 1, failed: selection.failed + (errorCode ? 1 : 0) };
    if (errorCode)
      await tx
        .insert(failures)
        .values({ jobId, sourceId, errorCode })
        .onConflictDoUpdate({ target: [failures.jobId, failures.sourceId], set: { errorCode } });
    else await tx.delete(failures).where(and(eq(failures.jobId, jobId), eq(failures.sourceId, sourceId)));
    await tx
      .update(jobs)
      .set({
        sourceSelection: next,
        result: {
          selection: { tracked: selection.tracksOutcomes, processed: next.processed, failed: next.failed, finished: false, action: next.action },
        },
        updatedAt: sql`now()`,
      })
      .where(eq(jobs.id, jobId));
    return next;
  }
}

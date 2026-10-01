import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, exists, gt, ilike, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import type { FanfictionJob, FanfictionSourceSelection } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { DatabaseTransaction } from '../../db/transaction';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionJobService } from './fanfiction-job.service';
import { FanfictionSourceService } from './fanfiction-source.service';
import { SelectFanfictionSourcesDto } from './dto/fanfiction-source-batch.dto';

const jobs = schema.fanfictionJobs;
const sources = schema.fanfictionSources;
const failures = schema.fanfictionSourceBatchFailures;

@Injectable()
export class FanfictionSourceBatchService {
  private readonly logger = new Logger(FanfictionSourceBatchService.name);
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly access: FanfictionAccessService,
    private readonly jobs: FanfictionJobService,
    private readonly sources: FanfictionSourceService,
  ) {}

  async start(libraryId: number, dto: SelectFanfictionSourcesDto, user: RequestUser) {
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
      const [inserted] = await tx
        .insert(jobs)
        .values({
          libraryId,
          userId: user.id,
          tokenVersion: user.tokenVersion,
          idempotencyKey: dto.idempotencyKey,
          kind: 'source_batch',
          site: `local-library-${libraryId}`,
          url: '',
          sourceSelection: { ...input, cutoff, cursor: null, processed: 0, failed: 0 },
          result: { selection: { processed: 0, failed: 0, finished: false, action: dto.action } },
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
    const job = await this.jobs.get(libraryId, jobId, user);
    if (job.kind !== 'source_batch') throw new NotFoundException('Story selection not found');
    const rows = await this.db
      .select({ sourceId: failures.sourceId, title: sources.title, errorCode: failures.errorCode })
      .from(failures)
      .innerJoin(sources, eq(sources.id, failures.sourceId))
      .where(and(eq(failures.jobId, jobId), eq(sources.libraryId, libraryId), cursor ? gt(failures.sourceId, cursor) : undefined))
      .orderBy(asc(failures.sourceId))
      .limit(limit + 1);
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.sourceId : null };
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
                    sql`${sources.updatedAt} <= ${selection.cutoff}::timestamptz`,
                    selection.state ? eq(sources.state, selection.state) : undefined,
                    selection.search ? ilike(sources.title, `%${selection.search}%`) : undefined,
                  ),
          ),
        )
        .orderBy(asc(sources.id))
        .limit(100);
      for (const source of batch) {
        if (signal.aborted) throw new ConflictException('Story selection was cancelled');
        try {
          selection = await this.db.transaction(async (tx) => {
            await this.jobs.assertOwnership(job, tx);
            await authorize();
            await this.apply(tx, job, source, selection, user);
            return this.checkpoint(tx, job.id, source.id, selection, null);
          });
        } catch (error) {
          if (!(error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException)) throw error;
          selection = await this.db.transaction(async (tx) => {
            await this.jobs.assertOwnership(job, tx);
            await authorize();
            return this.checkpoint(tx, job.id, source.id, selection, 'source_batch_item_failed');
          });
        }
        if (Date.now() - startedAt >= 20_000) break;
      }
      const finished = !batch.length || (batch.length < 100 && selection.cursor === batch.at(-1)!.id);
      this.logger.log(
        `[fanfiction.source_batch] [end] libraryId=${job.libraryId} jobId=${job.id} durationMs=${Date.now() - startedAt} processed=${selection.processed} failed=${selection.failed} finished=${finished} - story selection checkpoint saved`,
      );
      return { selection: { processed: selection.processed, failed: selection.failed, finished, action: selection.action } };
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
  ) {
    if (selection.action === 'schedule') return this.sources.setSchedule(tx, source, selection.intervalMinutes);
    if (selection.action === 'update' || selection.action === 'refresh') {
      await this.jobs.updateStory(source, selection.action, randomUUID(), user, false, undefined, tx);
      return;
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
    if (previous) await this.jobs.retry(job.libraryId, previous.id, user, tx);
  }

  private async checkpoint(tx: DatabaseTransaction, jobId: string, sourceId: string, selection: FanfictionSourceSelection, errorCode: string | null) {
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
        result: { selection: { processed: next.processed, failed: next.failed, finished: false, action: next.action } },
        updatedAt: sql`now()`,
      })
      .where(eq(jobs.id, jobId));
    return next;
  }
}

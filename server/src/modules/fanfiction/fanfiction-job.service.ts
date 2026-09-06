import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import type { FanfictionJob, FanfictionJobState, FanfictionImportRequest } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { DatabaseTransaction } from '../../db/transaction';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionProfileService } from './fanfiction-profile.service';
import { ListFanfictionJobsDto } from './dto/fanfiction-job.dto';
import { PreviewFanfictionDto } from './dto/fanfiction-profile.dto';
import { recordFanfictionActivity } from './fanfiction-activity';

const jobs = schema.fanfictionJobs;

@Injectable()
export class FanfictionJobService {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly access: FanfictionAccessService,
    private readonly profiles: FanfictionProfileService,
  ) {}

  async preview(libraryId: number, dto: PreviewFanfictionDto, user: RequestUser): Promise<FanfictionJob> {
    return this.enqueue(libraryId, dto, user, 'preview');
  }

  async importStory(libraryId: number, dto: FanfictionImportRequest, user: RequestUser): Promise<FanfictionJob> {
    return this.enqueue(libraryId, dto, user, 'import', { ...dto, intervalMinutes: dto.intervalMinutes === undefined ? 1440 : dto.intervalMinutes });
  }

  async updateStory(
    source: typeof schema.fanfictionSources.$inferSelect,
    kind: 'update' | 'refresh' | 'rollback' | 'replacement',
    idempotencyKey: string,
    user: RequestUser,
    scheduled = false,
    rollback?: { revisionId: string; expectedRevisionId: string },
    transaction?: DatabaseTransaction,
    replacement?: { uploadId: string; sha256: string; expectedRevisionId: string },
  ): Promise<FanfictionJob> {
    await this.access.administer(user, source.libraryId);
    const operation = async (tx: DatabaseTransaction) => {
      const [current] = await tx
        .select()
        .from(schema.fanfictionSources)
        .where(and(eq(schema.fanfictionSources.id, source.id), eq(schema.fanfictionSources.libraryId, source.libraryId)))
        .for('update');
      const [existing] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.libraryId, source.libraryId), eq(jobs.userId, user.id), eq(jobs.idempotencyKey, idempotencyKey)))
        .limit(1);
      if (existing) {
        if (
          existing.sourceId !== source.id ||
          existing.kind !== kind ||
          (kind === 'replacement' &&
            (existing.replacementSha256 !== replacement?.sha256 || existing.expectedRevisionId !== replacement?.expectedRevisionId)) ||
          (kind === 'rollback' &&
            (existing.rollbackRevisionId !== rollback?.revisionId || existing.expectedRevisionId !== rollback?.expectedRevisionId))
        )
          throw new ConflictException('Operation identity was reused with different input');
        return this.view(existing);
      }
      if (
        !current ||
        current.version !== source.version ||
        !current.bookFileId ||
        (!['rollback', 'replacement'].includes(kind) && current.attentionCode === 'destination_profile_required') ||
        !(
          ['rollback', 'replacement'].includes(kind) ? ['active', 'paused', 'configuration_blocked', 'review_required'] : ['active', 'paused']
        ).includes(current.state) ||
        (scheduled && current.state !== 'active')
      )
        throw new ConflictException('Story source changed or requires attention before updating');
      const [active] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.sourceId, source.id), inArray(jobs.state, ['queued', 'running'])))
        .limit(1);
      if (active) throw new ConflictException('An operation for this story is already active');
      const [row] = await tx
        .insert(jobs)
        .values({
          libraryId: source.libraryId,
          userId: user.id,
          tokenVersion: user.tokenVersion,
          idempotencyKey,
          sourceId: source.id,
          sourceVersion: current.version,
          profileId: current.profileId,
          ...(rollback ? { rollbackRevisionId: rollback.revisionId, expectedRevisionId: rollback.expectedRevisionId } : {}),
          ...(replacement
            ? { replacementUploadId: replacement.uploadId, replacementSha256: replacement.sha256, expectedRevisionId: replacement.expectedRevisionId }
            : {}),
          kind,
          scheduled,
          url: current.canonicalUrl,
          site: current.site,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new ConflictException('An operation for this story is already active');
      return this.view(row);
    };
    return transaction ? operation(transaction) : this.db.transaction(operation);
  }

  async recordReplacementReview(job: typeof jobs.$inferSelect, replacement: NonNullable<FanfictionJob['result']>['replacement']) {
    await this.db.transaction(async (tx) => {
      await this.assertOwnership(job, tx);
      await tx.update(jobs).set({ result: { replacement } }).where(eq(jobs.id, job.id));
    });
  }

  async approveReplacement(libraryId: number, id: string, sha256: string, expectedRevisionId: string, user: RequestUser) {
    await this.access.administer(user, libraryId);
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, id), eq(jobs.libraryId, libraryId)))
        .for('update');
      if (
        !job ||
        job.kind !== 'replacement' ||
        job.state !== 'review_required' ||
        job.errorCode !== 'replacement_chapter_reduction' ||
        job.replacementSha256 !== sha256 ||
        job.expectedRevisionId !== expectedRevisionId ||
        !job.result?.replacement?.identityMatches
      )
        throw new ConflictException('The replacement review changed; reload it before approving');
      await tx.update(jobs).set({ replacementReductionApproved: true }).where(eq(jobs.id, id));
      return this.retry(libraryId, id, user, tx);
    });
  }

  async enqueueDue(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const sources = schema.fanfictionSources;
      const due = await tx
        .select({ source: sources, tokenVersion: schema.users.tokenVersion })
        .from(sources)
        .innerJoin(schema.users, eq(schema.users.id, sources.createdBy))
        .where(
          and(
            eq(sources.state, 'active'),
            lte(sources.nextCheckAt, sql`now()`),
            sql`${sources.intervalMinutes} is not null`,
            sql`not exists (select 1 from ${jobs} where ${jobs.sourceId} = ${sources.id} and ${jobs.state} in ('queued', 'running'))`,
          ),
        )
        .orderBy(asc(sources.nextCheckAt), asc(sources.id))
        .limit(100)
        .for('update', { of: sources, skipLocked: true });
      let count = 0;
      for (const { source, tokenVersion } of due) {
        const [active] = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.sourceId, source.id), inArray(jobs.state, ['queued', 'running'])))
          .limit(1);
        if (active) continue;
        const rows = await tx
          .insert(jobs)
          .values({
            libraryId: source.libraryId,
            userId: source.createdBy,
            tokenVersion,
            idempotencyKey: randomUUID(),
            profileId: source.profileId,
            sourceId: source.id,
            sourceVersion: source.version,
            kind: 'update',
            scheduled: true,
            url: source.canonicalUrl,
            site: source.site,
            runAfter: sql`now() + (${Math.floor(Math.random() * 60)} * interval '1 second')`,
          })
          .onConflictDoNothing()
          .returning({ id: jobs.id });
        if (!rows.length) continue;
        await tx
          .update(sources)
          .set({ nextCheckAt: sql`now() + (${sources.intervalMinutes} * interval '1 minute')` })
          .where(eq(sources.id, source.id));
        count++;
      }
      return count;
    });
  }

  private async enqueue(
    libraryId: number,
    dto: PreviewFanfictionDto,
    user: RequestUser,
    kind: 'preview' | 'import',
    input?: FanfictionImportRequest,
  ): Promise<FanfictionJob> {
    await this.access.administer(user, libraryId);
    if (dto.profileId) await this.profiles.document(libraryId, dto.profileId, user);
    let url: URL;
    try {
      url = new URL(dto.url);
    } catch {
      throw new BadRequestException('Invalid story URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hostname.length > 255)
      throw new BadRequestException('A public HTTPS story URL is required');
    url.hash = '';
    const [row] = await this.db
      .insert(jobs)
      .values({
        libraryId,
        userId: user.id,
        tokenVersion: user.tokenVersion,
        idempotencyKey: dto.idempotencyKey,
        profileId: dto.profileId,
        kind,
        input,
        url: url.href,
        site: url.hostname.replace(/^www\./, ''),
      })
      .onConflictDoNothing()
      .returning();
    if (row) return this.view(row);
    const [existing] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.libraryId, libraryId), eq(jobs.userId, user.id), eq(jobs.idempotencyKey, dto.idempotencyKey)))
      .limit(1);
    if (
      !existing ||
      existing.url !== url.href ||
      existing.profileId !== (dto.profileId ?? null) ||
      existing.kind !== kind ||
      existing.input?.folderId !== input?.folderId ||
      existing.input?.intervalMinutes !== input?.intervalMinutes
    )
      throw new ConflictException('Operation identity was reused with different input');
    return this.view(existing);
  }

  async list(libraryId: number, dto: ListFanfictionJobsDto, user: RequestUser) {
    await this.access.administer(user, libraryId);
    const before = dto.cursor ? await this.find(libraryId, dto.cursor) : null;
    const rows = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.libraryId, libraryId),
          dto.kind ? eq(jobs.kind, dto.kind) : undefined,
          dto.sourceId ? eq(jobs.sourceId, dto.sourceId) : undefined,
          dto.activeOnly ? inArray(jobs.state, ['queued', 'running']) : undefined,
          before
            ? sql`(${jobs.createdAt}, ${jobs.id}) < (select ${jobs.createdAt}, ${jobs.id} from ${jobs} where ${jobs.id} = ${before.id} and ${jobs.libraryId} = ${libraryId})`
            : undefined,
        ),
      )
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(dto.limit + 1);
    const items = rows.slice(0, dto.limit).map((row) => this.view(row));
    return { items, nextCursor: rows.length > dto.limit ? items[items.length - 1].id : null };
  }

  async get(libraryId: number, id: string, user: RequestUser) {
    await this.access.administer(user, libraryId);
    return this.view(await this.find(libraryId, id));
  }

  async status(libraryId: number, ids: string[], user: RequestUser) {
    await this.access.administer(user, libraryId);
    if (ids.length > 100) throw new BadRequestException('Job status batch exceeds 100 items');
    if (!ids.length) return { items: [] };
    const rows = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.libraryId, libraryId), inArray(jobs.id, ids)))
      .limit(100);
    return { items: rows.map((row) => this.view(row)) };
  }

  async cancel(libraryId: number, id: string, user: RequestUser) {
    await this.access.administer(user, libraryId);
    await this.find(libraryId, id);
    await this.db
      .update(jobs)
      .set({ cancellationRequested: true, updatedAt: new Date() })
      .where(and(eq(jobs.libraryId, libraryId), eq(jobs.id, id), inArray(jobs.state, ['queued', 'running'])));
    await this.db
      .update(jobs)
      .set({ state: 'cancelled', updatedAt: new Date() })
      .where(and(eq(jobs.libraryId, libraryId), eq(jobs.id, id), eq(jobs.state, 'queued'), eq(jobs.cancellationRequested, true)));
    return this.get(libraryId, id, user);
  }

  async retry(libraryId: number, id: string, user: RequestUser, transaction?: DatabaseTransaction) {
    await this.access.administer(user, libraryId);
    const operation = async (tx: DatabaseTransaction) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.libraryId, libraryId), eq(jobs.id, id)))
        .for('update');
      if (!job) throw new NotFoundException('Fanfiction job not found in this library');
      if (['queued', 'running', 'succeeded', 'no_change'].includes(job.state)) return this.view(job);
      if (job.sourceId) {
        const [source] = await tx
          .select()
          .from(schema.fanfictionSources)
          .where(and(eq(schema.fanfictionSources.id, job.sourceId), eq(schema.fanfictionSources.libraryId, libraryId)))
          .for('update');
        if (!source || source.state === 'unlinked' || (job.sourceVersion !== null && source.version !== job.sourceVersion && !job.result?.revisionId))
          throw new ConflictException('Source settings changed; review the pending operation before retrying');
        const [other] = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.sourceId, source.id), inArray(jobs.state, ['queued', 'running'])))
          .limit(1);
        if (other) throw new ConflictException('Another operation for this story is already active');
        if (!job.result?.revisionId)
          await tx
            .update(schema.fanfictionSources)
            .set({
              state: source.bookFileId ? 'paused' : 'pending',
              attentionCode: source.attentionCode === 'destination_profile_required' ? source.attentionCode : null,
            })
            .where(eq(schema.fanfictionSources.id, source.id));
      }
      await this.access.administer(user, libraryId);
      const [updated] = await tx
        .update(jobs)
        .set({
          state: 'queued',
          userId: user.id,
          tokenVersion: user.tokenVersion,
          scheduled: false,
          cancellationRequested: false,
          attempts: 0,
          ...(job.kind === 'source_batch' && job.sourceSelection && job.state === 'review_required'
            ? {
                sourceSelection: { ...job.sourceSelection, cursor: null, processed: 0, failed: 0, retryFailedOnly: true },
                result: { selection: { processed: 0, failed: 0, finished: false, action: job.sourceSelection.action } },
              }
            : {}),
          ...(job.kind === 'adopt' && job.selection && job.state === 'review_required'
            ? {
                selection: { ...job.selection, cursor: null, processed: 0, failed: 0, retryFailedOnly: true },
                result: { selection: { processed: 0, failed: 0, finished: false } },
              }
            : {}),
          leaseOwner: null,
          leaseExpiresAt: null,
          errorCode: null,
          runAfter: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(jobs.id, id))
        .returning();
      return this.view(updated);
    };
    return transaction ? operation(transaction) : this.db.transaction(operation);
  }

  async claim() {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(184719, 1)`);
      const exhausted = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(eq(jobs.state, 'running'), lte(jobs.leaseExpiresAt, sql`now()`), or(eq(jobs.cancellationRequested, true), sql`${jobs.attempts} >= 3`)),
        )
        .limit(100)
        .for('update', { skipLocked: true });
      if (exhausted.length) {
        const failed = await tx
          .update(jobs)
          .set({
            state: sql`case when ${jobs.cancellationRequested} then 'cancelled' else 'failed' end`,
            errorCode: 'worker_lease_expired',
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: sql`now()`,
          })
          .where(
            inArray(
              jobs.id,
              exhausted.map((row) => row.id),
            ),
          )
          .returning();
        for (const job of failed) await this.recordFailure(tx, job);
      }
      const active = await tx
        .select({ site: jobs.site })
        .from(jobs)
        .where(and(eq(jobs.state, 'running'), gt(jobs.leaseExpiresAt, sql`now()`)))
        .limit(2);
      if (active.length >= 2) return null;
      const candidates = await tx
        .select()
        .from(jobs)
        .where(
          and(
            inArray(jobs.kind, ['preview', 'discovery', 'adopt', 'import', 'update', 'refresh', 'rollback', 'source_batch', 'replacement']),
            eq(jobs.cancellationRequested, false),
            lt(jobs.attempts, 3),
            active.length
              ? notInArray(
                  jobs.site,
                  active.map((row) => row.site),
                )
              : undefined,
            or(and(eq(jobs.state, 'queued'), lte(jobs.runAfter, sql`now()`)), and(eq(jobs.state, 'running'), lte(jobs.leaseExpiresAt, sql`now()`))),
          ),
        )
        .orderBy(asc(jobs.runAfter), asc(jobs.id))
        .limit(100)
        .for('update', { skipLocked: true });
      const candidate = candidates.find((row) => !active.some((other) => other.site === row.site));
      if (!candidate) return null;
      const [claimed] = await tx
        .update(jobs)
        .set({
          state: 'running',
          leaseOwner: randomUUID(),
          leaseExpiresAt: sql`now() + interval '60 seconds'`,
          attempts: candidate.attempts + 1,
          fence: candidate.fence + 1,
          updatedAt: sql`now()`,
        })
        .where(eq(jobs.id, candidate.id))
        .returning();
      return claimed;
    });
  }

  async renew(job: typeof jobs.$inferSelect): Promise<boolean> {
    const rows = await this.db
      .update(jobs)
      .set({ leaseExpiresAt: sql`now() + interval '60 seconds'` })
      .where(and(this.owned(job), eq(jobs.cancellationRequested, false)))
      .returning({ id: jobs.id });
    return rows.length === 1;
  }

  async yieldBatch(job: typeof jobs.$inferSelect, result: FanfictionJob['result']): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await this.assertOwnership(job, tx);
      const rows = await tx
        .update(jobs)
        .set({
          state: 'queued',
          result,
          attempts: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          runAfter: sql`now() + interval '1 second'`,
          updatedAt: sql`now()`,
        })
        .where(this.owned(job))
        .returning({ id: jobs.id });
      return rows.length === 1;
    });
  }

  async finish(
    job: typeof jobs.$inferSelect,
    state: FanfictionJobState,
    result: FanfictionJob['result'] = null,
    errorCode: string | null = null,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(jobs)
        .set({
          state: sql`case when ${jobs.cancellationRequested} then 'cancelled' else ${state} end`,
          result: result ?? sql`${jobs.result}`,
          errorCode,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: sql`now()`,
          ...(state === 'queued'
            ? { runAfter: sql`now() + (${Math.min(300, 15 * 2 ** job.attempts) + Math.floor(Math.random() * 15)} * interval '1 second')` }
            : {}),
        })
        .where(this.owned(job))
        .returning();
      if (rows[0]) await this.recordFailure(tx, rows[0]);
      if (rows[0]?.kind === 'source_batch' && rows[0].state === 'succeeded')
        await recordFanfictionActivity(tx, {
          libraryId: job.libraryId,
          userId: job.userId,
          jobId: job.id,
          eventKey: `${job.id}:batch-completed`,
          kind: 'batch_completed',
          title: `${rows[0].result?.selection?.processed ?? 0} story actions processed`,
        });
      return rows.length === 1;
    });
  }

  async assertOwnership(job: typeof jobs.$inferSelect, transaction: DatabaseTransaction): Promise<void> {
    const [owned] = await transaction
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          this.owned(job),
          eq(jobs.libraryId, job.libraryId),
          eq(jobs.userId, job.userId),
          eq(jobs.cancellationRequested, false),
          gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      )
      .for('update');
    if (!owned) throw new ConflictException('Queued operation ownership expired or was cancelled');
  }

  private async recordFailure(tx: DatabaseTransaction, job: typeof jobs.$inferSelect): Promise<void> {
    if (!['configuration_blocked', 'review_required', 'failed', 'cancelled'].includes(job.state)) return;
    let title =
      job.kind === 'source_batch'
        ? 'Bulk story actions'
        : job.kind === 'discovery'
          ? 'Existing book discovery'
          : job.kind === 'adopt'
            ? 'Existing book selection'
            : 'Story import';
    let bookId: number | null = null;
    if (job.sourceId) {
      await tx
        .update(schema.fanfictionSources)
        .set({
          ...(job.state === 'configuration_blocked' || job.state === 'review_required' ? { state: job.state } : {}),
          attentionCode: sql`case when ${schema.fanfictionSources.attentionCode} = 'destination_profile_required' then ${schema.fanfictionSources.attentionCode} else ${job.errorCode ?? job.state} end`,
          nextCheckAt: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.fanfictionSources.id, job.sourceId),
            eq(schema.fanfictionSources.libraryId, job.libraryId),
            job.sourceVersion === null ? eq(schema.fanfictionSources.state, 'pending') : eq(schema.fanfictionSources.version, job.sourceVersion),
          ),
        );
      const [source] = await tx
        .select({ title: schema.fanfictionSources.title, bookId: schema.fanfictionSources.bookId })
        .from(schema.fanfictionSources)
        .where(and(eq(schema.fanfictionSources.id, job.sourceId), eq(schema.fanfictionSources.libraryId, job.libraryId)))
        .limit(1);
      if (!source) return;
      title = source.title;
      bookId = source.bookId;
    } else if (!['import', 'discovery', 'adopt', 'source_batch'].includes(job.kind)) return;
    if (job.state !== 'cancelled')
      await recordFanfictionActivity(tx, {
        libraryId: job.libraryId,
        userId: job.userId,
        sourceId: job.sourceId,
        jobId: job.id,
        eventKey: `${job.id}:${job.state}`,
        kind: job.state === 'failed' ? 'failed' : 'attention',
        title,
        bookId,
        errorCode: job.errorCode,
      });
  }

  async bindSource(job: typeof jobs.$inferSelect, sourceId: string, transaction: DatabaseTransaction): Promise<boolean> {
    await this.assertOwnership(job, transaction);
    const [active] = await transaction
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.sourceId, sourceId), inArray(jobs.state, ['queued', 'running'])))
      .limit(1);
    if (active && active.id !== job.id) return false;
    await transaction.update(jobs).set({ sourceId }).where(eq(jobs.id, job.id));
    return true;
  }

  private owned(job: typeof jobs.$inferSelect) {
    return and(
      eq(jobs.id, job.id),
      eq(jobs.state, 'running'),
      eq(jobs.leaseOwner, job.leaseOwner!),
      eq(jobs.fence, job.fence),
      gt(jobs.leaseExpiresAt, sql`now()`),
    );
  }

  private async find(libraryId: number, id: string) {
    const [row] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.libraryId, libraryId), eq(jobs.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('Fanfiction job not found in this library');
    return row;
  }

  private view(row: typeof jobs.$inferSelect): FanfictionJob {
    return {
      id: row.id,
      libraryId: row.libraryId,
      kind: row.kind,
      state: row.state,
      url: row.url,
      attempts: row.attempts,
      cancellationRequested: row.cancellationRequested,
      result: row.result,
      errorCode: row.errorCode,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

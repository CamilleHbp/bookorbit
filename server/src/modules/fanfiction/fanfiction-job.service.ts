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
import { ListFanfictionProfilesDto, PreviewFanfictionDto } from './dto/fanfiction-profile.dto';

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
    kind: 'update' | 'refresh',
    idempotencyKey: string,
    user: RequestUser,
    scheduled = false,
  ): Promise<FanfictionJob> {
    await this.access.administer(user, source.libraryId);
    return this.db.transaction(async (tx) => {
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
        if (existing.sourceId !== source.id || existing.kind !== kind)
          throw new ConflictException('Operation identity was reused with different input');
        return this.view(existing);
      }
      if (
        !current ||
        current.version !== source.version ||
        !current.bookFileId ||
        !['active', 'paused'].includes(current.state) ||
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
          kind,
          scheduled,
          url: current.canonicalUrl,
          site: current.site,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new ConflictException('An operation for this story is already active');
      return this.view(row);
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

  async list(libraryId: number, dto: ListFanfictionProfilesDto, user: RequestUser) {
    await this.access.administer(user, libraryId);
    const before = dto.cursor ? await this.find(libraryId, dto.cursor) : null;
    const rows = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.libraryId, libraryId),
          before ? or(lt(jobs.createdAt, before.createdAt), and(eq(jobs.createdAt, before.createdAt), lt(jobs.id, before.id))) : undefined,
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

  async retry(libraryId: number, id: string, user: RequestUser) {
    await this.access.administer(user, libraryId);
    return this.db.transaction(async (tx) => {
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
            .set({ state: source.bookFileId ? 'paused' : 'pending', attentionCode: null })
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
          leaseOwner: null,
          leaseExpiresAt: null,
          errorCode: null,
          runAfter: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(jobs.id, id))
        .returning();
      return this.view(updated);
    });
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
      if (exhausted.length)
        await tx
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
          );
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
            inArray(jobs.kind, ['preview', 'import', 'update', 'refresh']),
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
        .returning({ id: jobs.id, sourceId: jobs.sourceId, sourceVersion: jobs.sourceVersion, state: jobs.state });
      const completed = rows[0];
      if (completed?.sourceId && ['configuration_blocked', 'review_required', 'failed', 'cancelled'].includes(completed.state)) {
        await tx
          .update(schema.fanfictionSources)
          .set({
            ...(completed.state === 'configuration_blocked' || completed.state === 'review_required' ? { state: completed.state } : {}),
            attentionCode: errorCode ?? completed.state,
            nextCheckAt: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(schema.fanfictionSources.id, completed.sourceId),
              eq(schema.fanfictionSources.libraryId, job.libraryId),
              completed.sourceVersion === null
                ? eq(schema.fanfictionSources.state, 'pending')
                : eq(schema.fanfictionSources.version, completed.sourceVersion),
            ),
          );
      }
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

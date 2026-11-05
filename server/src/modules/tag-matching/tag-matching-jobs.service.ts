import { labelKey, needsFandomReview } from './match-labels';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { TagMatchingChange, TagMatchingPreviewLabel } from '@bookorbit/types';
import { DB } from '../../db';
import * as s from '../../db/schema';
import type { DatabaseTransaction } from '../../db/transaction';
import type { RequestUser } from '../../common/types/request-user';
import { TagMatchingService } from './tag-matching.service';
import { TagMatchingManagementService } from './tag-matching-management.service';

type Field = 'tags' | 'genres';
@Injectable()
export class TagMatchingJobsService {
  private readonly logger = new Logger(TagMatchingJobsService.name);
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof s>,
    private readonly matching: TagMatchingService,
    private readonly management: TagMatchingManagementService,
  ) {}
  private async owned(user: RequestUser, id: string, tx: DatabaseTransaction) {
    if (!user.active) throw new ForbiddenException('Account is inactive');
    const [job] = await tx
      .select()
      .from(s.tagMatchingJobs)
      .where(and(eq(s.tagMatchingJobs.id, id), eq(s.tagMatchingJobs.userId, user.id)))
      .for('update');
    if (!job) throw new ForbiddenException('Preview is not available');
    return job;
  }
  private async current(job: typeof s.tagMatchingJobs.$inferSelect, tx: DatabaseTransaction) {
    const [rulebook] = await tx
      .select()
      .from(s.tagRulebooks)
      .where(and(eq(s.tagRulebooks.id, job.rulebookId), eq(s.tagRulebooks.userId, job.userId)))
      .for('share');
    if (!rulebook || rulebook.version !== job.version) throw new ConflictException('Matches changed. Create a new preview.');
  }
  async create(user: RequestUser, overrides: Field[]) {
    const own = await this.management.own(user);
    if (!own) throw new BadRequestException('Create your matching database first');
    const scope = await this.management.bookScope(user, true);
    return this.db.transaction(async (tx) => {
      const [job] = await tx.insert(s.tagMatchingJobs).values({ userId: user.id, rulebookId: own.id, version: own.version }).returning();
      await this.current(job, tx);
      await tx.execute(sql`insert into ${s.tagMatchingJobItems} (job_id, book_id, fingerprint, change, override_fields, state)
        select ${job.id}::uuid, ${s.books.id}, '',
          jsonb_build_object('bookId', ${s.books.id}, 'title', coalesce(${s.bookMetadata.title}, ''),
            'addedTags', '[]'::jsonb, 'removedTags', '[]'::jsonb, 'addedGenres', '[]'::jsonb, 'removedGenres', '[]'::jsonb,
            'lockedFields', '[]'::jsonb, 'unresolved', 0), ${JSON.stringify(overrides)}::jsonb, 'pending'
        from ${s.books} join ${s.bookMetadata} on ${s.bookMetadata.bookId} = ${s.books.id}
        join ${s.libraryTagRulebooks} on ${s.libraryTagRulebooks.libraryId} = ${s.books.libraryId}
        where ${scope} and ${s.libraryTagRulebooks.rulebookId} = ${own.id}
        and exists (select 1 from ${s.tagMatchingSnapshots} where ${s.tagMatchingSnapshots.bookId} = ${s.books.id} and ${s.tagMatchingSnapshots.rulebookId} = ${own.id})`);
      return job;
    });
  }
  async latest(user: RequestUser) {
    if (!user.active) throw new ForbiddenException('Account is inactive');
    const [job] = await this.db
      .select()
      .from(s.tagMatchingJobs)
      .where(eq(s.tagMatchingJobs.userId, user.id))
      .orderBy(sql`${s.tagMatchingJobs.createdAt} desc`)
      .limit(1);
    return job ?? null;
  }
  async items(user: RequestUser, id: string, page: number, pageSize: number) {
    const scope = await this.management.bookScope(user, true);
    return this.db.transaction(async (tx) => {
      const job = await this.owned(user, id, tx);
      const where = and(eq(s.tagMatchingJobItems.jobId, id), scope);
      const [total] = await tx
        .select({ count: count() })
        .from(s.tagMatchingJobItems)
        .innerJoin(s.books, eq(s.books.id, s.tagMatchingJobItems.bookId))
        .where(where);
      const items = await tx
        .select({ change: s.tagMatchingJobItems.change, state: s.tagMatchingJobItems.state, overrideFields: s.tagMatchingJobItems.overrideFields })
        .from(s.tagMatchingJobItems)
        .innerJoin(s.books, eq(s.books.id, s.tagMatchingJobItems.bookId))
        .where(where)
        .orderBy(asc(s.tagMatchingJobItems.bookId))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      return { job, items, total: total.count, page, pageSize };
    });
  }
  async details(user: RequestUser, id: string, bookId: number, page: number, pageSize: number) {
    const scope = await this.management.bookScope(user, true);
    return this.db.transaction(async (tx) => {
      const job = await this.owned(user, id, tx);
      await this.current(job, tx);
      const [item] = await tx
        .select({ item: s.tagMatchingJobItems })
        .from(s.tagMatchingJobItems)
        .innerJoin(s.books, eq(s.books.id, s.tagMatchingJobItems.bookId))
        .where(and(eq(s.tagMatchingJobItems.jobId, id), eq(s.tagMatchingJobItems.bookId, bookId), scope));
      if (!item) throw new ForbiddenException('Book preview is not available');
      const projected = await this.project(tx, bookId, job.rulebookId, item.item.overrideFields, true);
      if (projected.fingerprint !== item.item.fingerprint) throw new ConflictException('Book changed. Create a new preview.');
      return {
        change: projected.change,
        protectedChanges: projected.protectedChanges,
        labels: projected.labels.slice((page - 1) * pageSize, page * pageSize),
        total: projected.labels.length,
        page,
        pageSize,
      };
    });
  }
  async apply(user: RequestUser, id: string) {
    return this.db.transaction(async (tx) => {
      const job = await this.owned(user, id, tx);
      await this.current(job, tx);
      if (job.state !== 'ready') throw new ConflictException('Wait for a complete preview before applying');
      if (!job.changed) throw new BadRequestException('This preview has no changes to apply');
      const [updated] = await tx
        .update(s.tagMatchingJobs)
        .set({ state: 'running', approvedAt: new Date(), processed: job.skipped, changed: 0, skipped: job.skipped, updatedAt: new Date() })
        .where(eq(s.tagMatchingJobs.id, id))
        .returning();
      return updated;
    });
  }
  async advance(user: RequestUser, id: string) {
    if (!user.active) throw new ForbiddenException('Account is inactive');
    const startedAt = Date.now();
    let lastBookId = 0;
    this.logger.log(`[tag_matching_job] [start] jobId=${id} userId=${user.id} batchSize=10 - processing batch`);
    const scope = await this.management.bookScope(user, true);
    try {
      return await this.db.transaction(async (tx) => {
        const job = await this.owned(user, id, tx);
        if (job.state === 'failed') job.state = job.approvedAt ? 'running' : 'previewing';
        if (job.state !== 'previewing' && job.state !== 'running') return job;
        await this.current(job, tx);
        const previewing = job.state === 'previewing';
        const batch = await tx
          .select()
          .from(s.tagMatchingJobItems)
          .where(
            and(
              eq(s.tagMatchingJobItems.jobId, id),
              previewing ? eq(s.tagMatchingJobItems.fingerprint, '') : eq(s.tagMatchingJobItems.state, 'pending'),
            ),
          )
          .orderBy(asc(s.tagMatchingJobItems.bookId))
          .limit(10);
        let processed = job.processed,
          changed = job.changed,
          skipped = job.skipped;
        for (const item of batch) {
          lastBookId = item.bookId;
          const [book] = await tx
            .select({ id: s.books.id })
            .from(s.books)
            .innerJoin(s.libraryTagRulebooks, eq(s.libraryTagRulebooks.libraryId, s.books.libraryId))
            .where(and(eq(s.books.id, item.bookId), eq(s.libraryTagRulebooks.rulebookId, job.rulebookId), scope));
          processed++;
          const where = and(eq(s.tagMatchingJobItems.jobId, id), eq(s.tagMatchingJobItems.bookId, item.bookId));
          if (!book) {
            skipped++;
            await tx.update(s.tagMatchingJobItems).set({ state: 'skipped', fingerprint: 'unavailable' }).where(where);
            continue;
          }
          const projected = await this.project(tx, item.bookId, job.rulebookId, item.overrideFields);
          if (previewing) {
            if (this.hasChanges(projected.change)) changed++;
            await tx.update(s.tagMatchingJobItems).set({ fingerprint: projected.fingerprint, change: projected.change }).where(where);
          } else if (projected.fingerprint !== item.fingerprint) {
            skipped++;
            await tx.update(s.tagMatchingJobItems).set({ state: 'skipped' }).where(where);
          } else {
            for (const snapshot of projected.snapshots)
              await this.matching.sync(tx, item.bookId, snapshot, { expectedVersion: job.version, overrideFields: item.overrideFields });
            if (this.hasChanges(projected.change)) {
              changed++;
              await tx.update(s.bookMetadata).set({ updatedAt: new Date() }).where(eq(s.bookMetadata.bookId, item.bookId));
              await tx.update(s.books).set({ updatedAt: new Date() }).where(eq(s.books.id, item.bookId));
            }
            await tx.update(s.tagMatchingJobItems).set({ state: 'applied' }).where(where);
          }
        }
        const [remaining] = await tx
          .select({ count: count() })
          .from(s.tagMatchingJobItems)
          .where(
            and(
              eq(s.tagMatchingJobItems.jobId, id),
              previewing ? eq(s.tagMatchingJobItems.fingerprint, '') : eq(s.tagMatchingJobItems.state, 'pending'),
            ),
          );
        const [updated] = await tx
          .update(s.tagMatchingJobs)
          .set({
            processed,
            changed,
            skipped,
            state: remaining.count ? job.state : previewing ? 'ready' : 'completed',
            updatedAt: new Date(),
            error: skipped ? 'Some books changed or are no longer available. Create another preview to review them.' : null,
          })
          .where(eq(s.tagMatchingJobs.id, id))
          .returning();
        this.logger.log(
          `[tag_matching_job] [end] jobId=${id} userId=${user.id} durationMs=${Date.now() - startedAt} processed=${processed} changed=${changed} skipped=${skipped} - batch processed`,
        );
        return updated;
      });
    } catch (cause) {
      const error = cause instanceof ConflictException ? cause.message : `Could not process book ${lastBookId}. Retry this batch.`;
      await this.db
        .update(s.tagMatchingJobs)
        .set({ state: 'failed', error, updatedAt: new Date() })
        .where(and(eq(s.tagMatchingJobs.id, id), eq(s.tagMatchingJobs.userId, user.id)));
      this.logger.warn(
        `[tag_matching_job] [fail] jobId=${id} userId=${user.id} bookId=${lastBookId} durationMs=${Date.now() - startedAt} errorClass=${cause instanceof Error ? cause.name : 'Unknown'} error="Batch failed" - batch rolled back`,
      );
      throw cause;
    }
  }
  private hasChanges(change: TagMatchingChange) {
    return change.addedTags.length + change.removedTags.length + change.addedGenres.length + change.removedGenres.length > 0;
  }
  private async project(tx: DatabaseTransaction, bookId: number, rulebookId: number, overrides: Field[], includeLabels = false) {
    const [metadata] = await tx
      .select({ title: s.bookMetadata.title, lockedFields: s.bookMetadata.lockedFields })
      .from(s.bookMetadata)
      .where(eq(s.bookMetadata.bookId, bookId))
      .for('update');
    if (!metadata) throw new ConflictException('Book metadata is no longer available');
    const snapshots = await tx
      .select({ source: s.tagMatchingSnapshots.source, sourceKey: s.tagMatchingSnapshots.sourceKey, labels: s.tagMatchingSnapshots.labels })
      .from(s.tagMatchingSnapshots)
      .where(and(eq(s.tagMatchingSnapshots.bookId, bookId), eq(s.tagMatchingSnapshots.rulebookId, rulebookId)))
      .orderBy(s.tagMatchingSnapshots.sourceKey);
    const tags = await tx
      .select({ id: s.tags.id, name: s.tags.name, managed: s.bookTags.managedOnly })
      .from(s.bookTags)
      .innerJoin(s.tags, eq(s.tags.id, s.bookTags.tagId))
      .where(eq(s.bookTags.bookId, bookId))
      .orderBy(s.tags.id);
    const genres = await tx
      .select({ id: s.genres.id, name: s.genres.name, managed: s.bookGenres.managedOnly })
      .from(s.bookGenres)
      .innerJoin(s.genres, eq(s.genres.id, s.bookGenres.genreId))
      .where(eq(s.bookGenres.bookId, bookId))
      .orderBy(s.genres.id);
    const tagClaims = await tx
      .select()
      .from(s.bookTagSources)
      .where(eq(s.bookTagSources.bookId, bookId))
      .orderBy(s.bookTagSources.tagId, s.bookTagSources.sourceKey);
    const genreClaims = await tx
      .select()
      .from(s.bookGenreSources)
      .where(eq(s.bookGenreSources.bookId, bookId))
      .orderBy(s.bookGenreSources.genreId, s.bookGenreSources.sourceKey);
    const exclusions = await tx
      .select({ tagId: s.tagMatchingExclusions.tagId, genreId: s.tagMatchingExclusions.genreId })
      .from(s.tagMatchingExclusions)
      .where(eq(s.tagMatchingExclusions.bookId, bookId))
      .orderBy(s.tagMatchingExclusions.id);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ metadata, snapshots, tags, genres, tagClaims, genreClaims, exclusions }))
      .digest('hex');
    const desired = { tags: new Map<number, string>(), genres: new Map<number, string>() };
    const labels: TagMatchingPreviewLabel[] = [];
    let unresolved = 0;
    let missingFandom = false;
    const fandomReviewed = snapshots.some((snapshot) => snapshot.sourceKey === 'manual:fandom');
    for (const snapshot of snapshots) {
      const result = await this.matching.resolve(tx, rulebookId, snapshot.source, snapshot.labels, snapshot.sourceKey);
      unresolved += result.pending.length;
      if (includeLabels) {
        for (const label of snapshot.labels) {
          const key = labelKey(label.value);
          const contains = (rows: typeof snapshot.labels) => rows.some((row) => row.field === label.field && labelKey(row.value) === key);
          const status = contains(result.suppressed)
            ? 'suppressed'
            : contains(result.pending)
              ? 'pending'
              : contains(result.ignored)
                ? 'ignored'
                : 'matched';
          const candidates = result.rules.filter((rule) => rule.field === label.field && labelKey(rule.value) === key);
          const rule = candidates.find((rule) => rule.source === snapshot.source) ?? candidates.find((rule) => rule.source === null);
          labels.push({
            ...label,
            source: snapshot.source,
            sourceKey: snapshot.sourceKey,
            status,
            targets:
              status === 'matched'
                ? (rule?.targets ?? [])
                    .filter((target) => result.targets.some((resolved) => resolved.field === target.field && resolved.id === target.id))
                    .map((target) => ({
                      ...target,
                      name: result.names.get(`${target.field}:${target.id}`)!,
                      excluded: exclusions.some((e) => (target.field === 'tags' ? e.tagId === target.id : e.genreId === target.id)),
                    }))
                : [],
          });
        }
        if (!fandomReviewed && needsFandomReview(snapshot.labels, result.suppressed, result.hasFandom))
          labels.push({
            source: snapshot.source,
            sourceKey: snapshot.sourceKey,
            field: 'fandoms',
            value: 'missing-fandom',
            status: 'missing-fandom',
            targets: [],
          });
      }
      if (!fandomReviewed && needsFandomReview(snapshot.labels, result.suppressed, result.hasFandom)) missingFandom = true;
      for (const target of result.targets) {
        if (exclusions.some((e) => (target.field === 'tags' ? e.tagId === target.id : e.genreId === target.id))) continue;
        desired[target.field].set(target.id, result.names.get(`${target.field}:${target.id}`)!);
      }
    }
    if (missingFandom) unresolved++;
    const sourceKeys = new Set(snapshots.map((snapshot) => snapshot.sourceKey));
    const diff = (field: Field, current: typeof tags, claims: Array<{ id: number; sourceKey: string }>, respectLocks = true) => {
      if (respectLocks && metadata.lockedFields.includes(field) && !overrides.includes(field)) return { added: [], removed: [] };
      const next = new Map(desired[field]);
      const external = new Set(
        claims
          .filter((claim) => !sourceKeys.has(claim.sourceKey) || (field === 'genres' && claim.sourceKey.startsWith('fanfiction:')))
          .map((claim) => claim.id),
      );
      const owned = new Set(claims.filter((claim) => sourceKeys.has(claim.sourceKey)).map((claim) => claim.id));
      for (const row of current) if (!row.managed || !owned.has(row.id) || external.has(row.id)) next.set(row.id, row.name);
      const currentIds = new Set(current.map((row) => row.id));
      return {
        added: [...next]
          .filter(([id]) => !currentIds.has(id))
          .map(([, name]) => name)
          .sort(),
        removed: current
          .filter((row) => !next.has(row.id))
          .map((row) => row.name)
          .sort(),
      };
    };
    const tagDiff = diff(
      'tags',
      tags,
      tagClaims.map((row) => ({ id: row.tagId, sourceKey: row.sourceKey })),
    );
    const genreDiff = diff(
      'genres',
      genres,
      genreClaims.map((row) => ({ id: row.genreId, sourceKey: row.sourceKey })),
    );
    const change: TagMatchingChange = {
      bookId,
      title: metadata.title ?? '',
      addedTags: tagDiff.added,
      removedTags: tagDiff.removed,
      addedGenres: genreDiff.added,
      removedGenres: genreDiff.removed,
      lockedFields: metadata.lockedFields.filter((field) => field === 'tags' || field === 'genres'),
      unresolved,
    };
    const protectedTags =
      metadata.lockedFields.includes('tags') && !overrides.includes('tags')
        ? diff(
            'tags',
            tags,
            tagClaims.map((row) => ({ id: row.tagId, sourceKey: row.sourceKey })),
            false,
          )
        : { added: [], removed: [] };
    const protectedGenres =
      metadata.lockedFields.includes('genres') && !overrides.includes('genres')
        ? diff(
            'genres',
            genres,
            genreClaims.map((row) => ({ id: row.genreId, sourceKey: row.sourceKey })),
            false,
          )
        : { added: [], removed: [] };
    labels.sort(
      (a, b) =>
        Number(['pending', 'missing-fandom'].includes(b.status)) - Number(['pending', 'missing-fandom'].includes(a.status)) ||
        a.value.localeCompare(b.value),
    );
    return {
      fingerprint,
      change,
      snapshots,
      labels,
      protectedChanges: {
        addedTags: protectedTags.added,
        removedTags: protectedTags.removed,
        addedGenres: protectedGenres.added,
        removedGenres: protectedGenres.removed,
      },
    };
  }
}

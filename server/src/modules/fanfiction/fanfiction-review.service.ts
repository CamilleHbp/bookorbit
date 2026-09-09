import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FanfictionImportReviewRequest, FanfictionMetadataResolution, FanfictionPreview } from '@bookorbit/types';
import { DB } from '../../db';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import * as schema from '../../db/schema';
import type { DatabaseTransaction } from '../../db/transaction';
import type { RequestUser } from '../../common/types/request-user';
import { ManagedMetadataService } from '../metadata/managed-metadata.service';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionJobService } from './fanfiction-job.service';
import { planStoryMetadata, storyTags } from './fanfiction-metadata-review';
import { validateFanfictionPreview } from './fanfiction-preview';

const jobs = schema.fanfictionJobs;
const sources = schema.fanfictionSources;
type Job = typeof jobs.$inferSelect;

@Injectable()
export class FanfictionReviewService {
  private readonly logger = new Logger(FanfictionReviewService.name);
  private async operation<T>(event: string, libraryId: number, jobId: string, run: () => Promise<T>) {
    const started = Date.now();
    this.logger.log(`[${event}] [start] libraryId=${libraryId} jobId=${jobId} - processing story review`);
    try {
      const result = await run();
      this.logger.log(`[${event}] [end] libraryId=${libraryId} jobId=${jobId} durationMs=${Date.now() - started} - story review processed`);
      return result;
    } catch (error) {
      this.logger.warn(
        `[${event}] [fail] libraryId=${libraryId} jobId=${jobId} durationMs=${Date.now() - started} errorClass=ReviewError error="${sanitizeLogValue(error instanceof Error ? error.message : 'Review failed')}" - story review failed`,
      );
      throw error;
    }
  }
  prepare(job: Job, preview: FanfictionPreview, noChange: boolean, reuseApproval = false) {
    preview = validateFanfictionPreview(preview);
    return this.operation('fanfiction.prepare_review', job.libraryId, job.id, () => this.prepareInternal(job, preview, noChange, reuseApproval));
  }
  decide(libraryId: number, sourceId: string, dto: FanfictionMetadataResolution, user: RequestUser, action: 'apply' | 'later' | 'discard') {
    return this.operation(`fanfiction.review_${action}`, libraryId, dto.jobId, () => this.decideInternal(libraryId, sourceId, dto, user, action));
  }
  importDecision(libraryId: number, jobId: string, dto: FanfictionImportReviewRequest, user: RequestUser) {
    return this.operation(`fanfiction.import_${dto.action}`, libraryId, jobId, () => this.importDecisionInternal(libraryId, jobId, dto, user));
  }

  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly metadata: ManagedMetadataService,
    private readonly catalog: RevisionCatalogService,
    private readonly access: FanfictionAccessService,
    private readonly jobService: FanfictionJobService,
  ) {}

  private async prepareInternal(job: Job, preview: FanfictionPreview, noChange: boolean, reuseApproval: boolean) {
    return this.db.transaction(async (tx) => {
      await this.jobService.assertOwnership(job, tx);
      const [source] = await tx
        .select()
        .from(sources)
        .where(and(eq(sources.id, job.sourceId!), eq(sources.libraryId, job.libraryId)))
        .for('update');
      if (!source?.bookId || source.version !== job.sourceVersion) throw new ConflictException('The story changed while preparing its update');
      const snapshot = await this.metadata.snapshot(tx, source.bookId, job.libraryId, `fanfiction:${source.id}`);
      const [stored] = await tx.select().from(jobs).where(eq(jobs.id, job.id)).limit(1);
      const previousPlan = stored.result?.preparedUpdate;
      if (previousPlan?.metadataApplied || (reuseApproval && previousPlan?.approved && previousPlan.fingerprint === snapshot.fingerprint))
        return stored.result!;
      const [previous] = await tx
        .select({ result: jobs.result })
        .from(jobs)
        .where(
          and(
            eq(jobs.sourceId, source.id),
            eq(jobs.libraryId, job.libraryId),
            sql`${jobs.id} <> ${job.id}`,
            sql`(${jobs.result}->>'revisionId' is not null or ${jobs.result}->>'bookId' is not null or ${jobs.result}->>'reviewDiscarded' = 'true')`,
            sql`${jobs.result}->'preview' is not null`,
            sql`${jobs.result}->'metadataReview' is null`,
            sql`coalesce(${jobs.result}->>'reviewDiscarded', 'false') <> 'true'`,
          ),
        )
        .orderBy(desc(jobs.createdAt), desc(jobs.id))
        .limit(1);
      const plan = planStoryMetadata(snapshot.current, preview, snapshot.managedTags, snapshot.lockedFields, previous?.result?.preview);
      const remote = storyTags(preview.tags);
      const previousState = previousPlan?.previousState ?? (source.state === 'paused' ? 'paused' : 'active');
      const result: NonNullable<Job['result']> = {
        preview,
        sourceId: source.id,
        bookId: source.bookId,
        bookFileId: source.bookFileId!,
        preparedUpdate: {
          noChange,
          previousState,
          values: plan.values,
          fields: ['title', 'description', 'authors', 'tags'],
          fingerprint: snapshot.fingerprint,
          approved: !plan.fields.length,
          baseline: previous?.result?.preview,
        },
        ...(plan.fields.length
          ? {
              metadataReview: {
                current: snapshot.current,
                incoming: preview,
                fields: plan.fields,
                lockedFields: snapshot.lockedFields,
                fingerprint: snapshot.fingerprint,
                previousState,
                beforeUpdate: true,
                tags: {
                  custom: snapshot.customTags,
                  managed: snapshot.managedTags,
                  added: remote.filter((tag) => !snapshot.managedTags.includes(tag)),
                  removed: snapshot.managedTags.filter((tag) => !remote.includes(tag)),
                },
                choices: stored.result?.metadataReview?.choices,
              },
            }
          : {}),
      };
      await tx.update(jobs).set({ result }).where(eq(jobs.id, job.id));
      return result;
    });
  }

  async refresh(tx: DatabaseTransaction, job: Pick<Job, 'id' | 'result'>, source: typeof sources.$inferSelect) {
    const snapshot = await this.metadata.snapshot(tx, source.bookId!, source.libraryId, `fanfiction:${source.id}`);
    const review = job.result!.metadataReview!;
    const prepared = job.result!.preparedUpdate!;
    const plan = planStoryMetadata(snapshot.current, review.incoming, snapshot.managedTags, snapshot.lockedFields, prepared.baseline);
    const remote = storyTags(review.incoming.tags);
    const updated = {
      ...review,
      current: snapshot.current,
      fields: plan.fields,
      lockedFields: snapshot.lockedFields,
      fingerprint: snapshot.fingerprint,
      tags: {
        custom: snapshot.customTags,
        managed: snapshot.managedTags,
        added: remote.filter((tag) => !snapshot.managedTags.includes(tag)),
        removed: snapshot.managedTags.filter((tag) => !remote.includes(tag)),
      },
    };
    await tx
      .update(jobs)
      .set({
        result: {
          ...job.result,
          metadataReview: updated,
          preparedUpdate: { ...prepared, approved: false, values: plan.values, fingerprint: snapshot.fingerprint },
        },
      })
      .where(eq(jobs.id, job.id));
    return { jobId: job.id, review: updated };
  }

  async upgradeUnchangedReview(tx: DatabaseTransaction, job: Pick<Job, 'id' | 'result'>, source: typeof sources.$inferSelect) {
    const revisionId = job.result!.revisionId!;
    await this.catalog.lockCurrent(tx, source.bookFileId!, source.libraryId, revisionId);
    const snapshot = await this.metadata.snapshot(tx, source.bookId!, source.libraryId, `fanfiction:${source.id}`);
    const review = job.result!.metadataReview!;
    job.result = {
      ...job.result,
      metadataReview: { ...review, beforeUpdate: true },
      preparedUpdate: {
        noChange: true,
        previousState: review.previousState,
        values: { ...snapshot.current, tags: snapshot.managedTags },
        fields: ['title', 'description', 'authors', 'tags'],
        approved: false,
        fingerprint: snapshot.fingerprint,
      },
    };
    delete job.result.revisionId;
    delete job.result.noChange;
    await tx
      .update(jobs)
      .set({
        result: job.result,
        state: 'review_required',
        errorCode: 'metadata_review_required',
        sourceVersion: source.version,
        expectedRevisionId: revisionId,
      })
      .where(eq(jobs.id, job.id));
    return this.refresh(tx, job, source);
  }

  async assertApproved(job: Job, tx: DatabaseTransaction) {
    const [stored] = await tx.select().from(jobs).where(eq(jobs.id, job.id)).limit(1);
    const plan = stored.result?.preparedUpdate;
    if (!plan) return; // Publications created before review staging retain their recovery path.
    if (!plan.approved) throw new ConflictException({ message: 'Review the update before applying it.', errorCode: 'metadata_review_required' });
    if (stored.result?.revisionId || plan.metadataApplied) return;
    const snapshot = await this.metadata.snapshot(tx, stored.result!.bookId!, job.libraryId, `fanfiction:${job.sourceId}`);
    if (snapshot.fingerprint !== plan.fingerprint)
      throw new ConflictException({ message: 'Book details changed. Review the update again.', errorCode: 'metadata_review_required' });
  }

  async apply(tx: DatabaseTransaction, job: Job, bookId: number) {
    const [stored] = await tx.select().from(jobs).where(eq(jobs.id, job.id)).limit(1);
    const plan = stored.result?.preparedUpdate;
    if (plan && !plan.metadataApplied) {
      await this.assertApproved(job, tx);
      await this.metadata.apply(tx, bookId, { key: `fanfiction:${job.sourceId}`, libraryId: job.libraryId }, plan.values, plan.fields);
      plan.metadataApplied = true;
    }
    const result = { ...stored.result };
    delete result.metadataReview;
    if (plan) await tx.update(jobs).set({ result }).where(eq(jobs.id, job.id));
    return result;
  }

  private async decideInternal(
    libraryId: number,
    sourceId: string,
    dto: FanfictionMetadataResolution,
    user: RequestUser,
    action: 'apply' | 'later' | 'discard',
  ) {
    await this.access.administer(user, libraryId);
    await this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, dto.jobId), eq(jobs.libraryId, libraryId), eq(jobs.sourceId, sourceId)))
        .for('update');
      if (!job?.result?.preparedUpdate || !job.result.metadataReview || !['review_required', 'failed', 'configuration_blocked'].includes(job.state))
        throw new ConflictException('Refresh this review before continuing');
      const review = job.result.metadataReview;
      if (action === 'discard') {
        const [publication] = await tx
          .select({ state: schema.revisionPublications.state })
          .from(schema.revisionPublications)
          .where(and(eq(schema.revisionPublications.ownerKey, job.id), eq(schema.revisionPublications.libraryId, libraryId)))
          .limit(1);
        if (publication && !['prepared', 'failed'].includes(publication.state))
          throw new ConflictException('This update has started applying. Wait for recovery to finish.');
      }
      const [source] = await tx
        .select()
        .from(sources)
        .where(and(eq(sources.id, sourceId), eq(sources.libraryId, libraryId)))
        .for('update');
      if (!source?.bookId || (action !== 'discard' && (source.state === 'unlinked' || source.version !== job.sourceVersion)))
        throw new ConflictException('The story settings changed. Discard this update and check again.');
      if (action !== 'discard') await this.catalog.lockCurrent(tx, source.bookFileId!, libraryId, job.expectedRevisionId!);
      const snapshot = await this.metadata.snapshot(tx, source.bookId, libraryId, `fanfiction:${sourceId}`);
      if (action !== 'discard' && snapshot.fingerprint !== dto.fingerprint)
        throw new ConflictException('Book details changed. Refresh the review before continuing.');
      const choices = { title: dto.title, description: dto.description, authors: dto.authors, tags: dto.tags, selectedTags: dto.selectedTags };
      if (action === 'later') {
        await tx
          .update(jobs)
          .set({ result: { ...job.result, metadataReview: { ...review, choices } } })
          .where(eq(jobs.id, job.id));
        return;
      }
      const values = { ...job.result.preparedUpdate.values };
      for (const field of action === 'discard' ? [] : review.fields) {
        if (dto[field] === 'keep') {
          Object.assign(values, { [field]: field === 'tags' ? snapshot.managedTags : snapshot.current[field] });
          continue;
        }
        if (snapshot.lockedFields.includes(field)) throw new ConflictException('This field is locked. Keep its library value.');
        if (field !== 'tags') Object.assign(values, { [field]: review.incoming[field] });
        else {
          const allowed = storyTags([...snapshot.managedTags, ...review.incoming.tags]);
          const selected = dto.tags === 'select' ? storyTags(dto.selectedTags ?? []) : allowed;
          if (selected.some((tag) => !allowed.includes(tag))) throw new BadRequestException('Select tags from the proposed update');
          values.tags = selected;
        }
      }
      const result = {
        ...job.result,
        preparedUpdate: { ...job.result.preparedUpdate, approved: action === 'apply', values, fingerprint: snapshot.fingerprint },
        ...(action === 'discard' ? { reviewDiscarded: true } : {}),
      };
      if (action === 'discard') delete result.metadataReview;
      await tx
        .update(jobs)
        .set({
          result,
          state: action === 'apply' ? 'queued' : 'cancelled',
          cancellationRequested: action === 'discard',
          userId: user.id,
          tokenVersion: user.tokenVersion,
          scheduled: false,
          attempts: 0,
          errorCode: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          runAfter: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(jobs.id, job.id));
      if (source.version === job.sourceVersion && source.state !== 'unlinked')
        await tx
          .update(sources)
          .set({
            state: review.previousState,
            attentionCode: null,
            nextCheckAt:
              review.previousState === 'active' && source.intervalMinutes !== null
                ? sql`now() + (${source.intervalMinutes} * interval '1 minute')`
                : null,
          })
          .where(eq(sources.id, sourceId));
    });
    return this.jobService.get(libraryId, dto.jobId, user);
  }

  private async importDecisionInternal(libraryId: number, jobId: string, dto: FanfictionImportReviewRequest, user: RequestUser) {
    await this.access.administer(user, libraryId);
    await this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.libraryId, libraryId)))
        .for('update');
      if (!job?.result?.importReview || job.result.importReview.approved || job.state !== 'review_required')
        throw new ConflictException('Refresh the import review before continuing');
      const review = job.result.importReview;
      const values = dto.values ?? review.values;
      validateFanfictionPreview({ ...review.preview, ...values });
      const [source] = await tx
        .select()
        .from(sources)
        .where(and(eq(sources.id, job.sourceId!), eq(sources.libraryId, libraryId)))
        .for('update');
      if (!source || source.bookFileId || source.state === 'unlinked') throw new ConflictException('The story import changed. Start again.');
      await tx
        .update(jobs)
        .set({
          result: { ...job.result, importReview: { ...review, values, approved: dto.action === 'apply' } },
          ...(dto.action !== 'later'
            ? {
                state: dto.action === 'apply' ? ('queued' as const) : ('cancelled' as const),
                cancellationRequested: dto.action === 'discard',
                userId: user.id,
                tokenVersion: user.tokenVersion,
                attempts: 0,
                errorCode: null,
                runAfter: sql`now()`,
              }
            : {}),
        })
        .where(eq(jobs.id, jobId));
      if (dto.action !== 'later')
        await tx
          .update(sources)
          .set({ state: dto.action === 'apply' ? 'pending' : 'unlinked', attentionCode: null })
          .where(eq(sources.id, source.id));
    });
    return this.jobService.get(libraryId, jobId, user);
  }
}

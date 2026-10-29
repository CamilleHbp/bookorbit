import { FanfictionReviewService } from './fanfiction-review.service';
import { MetadataService } from '../metadata/metadata.service';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';
import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { DatabaseTransaction } from '../../db/transaction';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { RevisionInterruptionService } from '../book-revision/revision-interruption.service';
import { recordFanfictionActivity } from './fanfiction-activity';
import { ManagedMetadataService } from '../metadata/managed-metadata.service';
import { changedStoryMetadata } from './fanfiction-metadata-review';

const jobs = schema.fanfictionJobs;
const sources = schema.fanfictionSources;

@Injectable()
export class FanfictionRecoveryService {
  private readonly logger = new Logger(FanfictionRecoveryService.name);
  private recovering = false;
  private cursor: string | undefined;
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly revisions: RevisionInterruptionService,
    private readonly metadata: ManagedMetadataService,
    private readonly reviews: FanfictionReviewService,
    private readonly covers: MetadataService,
    private readonly catalog: RevisionCatalogService,
  ) {}

  @Interval(5000)
  async recover(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    const startedAt = Date.now();
    let recovered = 0;
    let failed = 0;
    let started = false;
    try {
      const pending = await this.revisions.pending(this.cursor);
      this.cursor = pending.length === 100 ? pending.at(-1)!.id : undefined;
      if (!pending.length) return;
      const owners = await this.db
        .select()
        .from(jobs)
        .where(
          inArray(
            jobs.id,
            pending.map((row) => row.ownerKey!),
          ),
        );
      const byId = new Map(owners.map((job) => [job.id, job]));
      for (const row of pending) {
        const owner = byId.get(row.ownerKey!);
        const hasReceipt = row.state === 'cleanup_complete' && owner?.result?.revisionId === row.nextRevisionId;
        if (owner?.result?.metadataReview?.beforeUpdate && !owner.cancellationRequested && !owner.result.preparedUpdate?.approved) continue;
        if (owner && !hasReceipt && !owner.cancellationRequested && ['queued', 'running'].includes(owner.state)) continue;
        if (!started) {
          started = true;
          this.logger.log(`[fanfiction.recover_publications] [start] batchSize=${pending.length} - publication recovery batch started`);
        }
        try {
          if (hasReceipt) {
            await this.db.transaction(async (tx) => {
              const current = await this.lockOwner(tx, row.ownerKey!, row.libraryId);
              if (current?.result?.revisionId !== row.nextRevisionId) throw new ConflictException('Operation receipt changed before recovery');
              if (current.cancellationRequested || !['queued', 'running', 'succeeded'].includes(current.state))
                await this.recordPublished(tx, current, row.nextRevisionId, row.bookFileId);
              await this.revisions.acknowledge(tx, row.id, row.ownerKey!);
            });
          } else {
            const revisionId = await this.revisions.settle(row.id, row.libraryId, {
              ownerKey: row.ownerKey!,
              commit: async (tx) => {
                const job = await this.lockOwner(tx, row.ownerKey!, row.libraryId);
                if (job?.result?.preparedUpdate) await this.reviews.apply(tx, job, job.result.bookId!);
              },
              authorize: async (tx) => {
                await this.requireInterrupted(tx, row.ownerKey!, row.libraryId);
              },
            });
            if (revisionId && owner?.result?.preparedUpdate?.approved) {
              const file = await this.catalog.fileLocation(row.bookFileId, row.libraryId);
              if (file.bookId !== owner.result.bookId) throw new ConflictException('The reviewed book changed before recovery');
              await this.covers.refreshCoverForBook(file.bookId, file.absolutePath, 'epub');
            }
            await this.db.transaction(async (tx) => {
              const current = await this.requireInterrupted(tx, row.ownerKey!, row.libraryId);
              if (current && revisionId) await this.recordPublished(tx, current, revisionId, row.bookFileId);
              await this.revisions.acknowledge(tx, row.id, row.ownerKey!);
            });
          }
          recovered++;
        } catch (error) {
          failed++;
          this.logger.warn(
            `[fanfiction.recover_publications] [fail] publicationId=${row.id} libraryId=${row.libraryId} durationMs=${Date.now() - startedAt} errorClass=RecoveryError error="${sanitizeLogValue(error instanceof Error ? error.message : 'Recovery failed')}" - publication recovery will retry`,
          );
        }
      }
      if (recovered || failed)
        this.logger.log(
          `[fanfiction.recover_publications] [end] durationMs=${Date.now() - startedAt} recovered=${recovered} failed=${failed} - publication recovery batch completed`,
        );
    } catch {
      this.logger.warn(
        `[fanfiction.recover_publications] [fail] durationMs=${Date.now() - startedAt} errorClass=RecoveryError error="Recovery unavailable" - publication recovery failed`,
      );
    } finally {
      this.recovering = false;
    }
  }

  private async lockOwner(tx: DatabaseTransaction, id: string, libraryId: number) {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update');
    if (job && job.libraryId !== libraryId) throw new ConflictException('Publication owner belongs to another library');
    return job;
  }

  private async requireInterrupted(tx: DatabaseTransaction, id: string, libraryId: number) {
    const job = await this.lockOwner(tx, id, libraryId);
    if (
      job &&
      !job.cancellationRequested &&
      (['queued', 'running'].includes(job.state) || (job.result?.metadataReview?.beforeUpdate && !job.result.preparedUpdate?.approved))
    )
      throw new ConflictException('Publication owner resumed before recovery');
    return job;
  }

  private async recordPublished(tx: DatabaseTransaction, job: typeof jobs.$inferSelect, revisionId: string, bookFileId: number) {
    if (job.result?.revisionId && job.result.revisionId !== revisionId)
      throw new ConflictException('A later attempt has a different publication receipt');
    const [source] = job.sourceId
      ? await tx
          .select()
          .from(sources)
          .where(and(eq(sources.id, job.sourceId), eq(sources.libraryId, job.libraryId), eq(sources.bookFileId, bookFileId)))
          .for('update')
      : [];
    if (source && job.result?.preparedUpdate) job.result = await this.reviews.apply(tx, job, source.bookId!);
    if (source && !job.result?.revisionId) {
      if (source.version === job.sourceVersion && source.state !== 'unlinked') {
        const preview = job.result?.preview;
        if (!job.result?.preparedUpdate && preview && source.bookId && job.kind !== 'rollback') {
          const snapshot = await this.metadata.snapshot(tx, source.bookId, job.libraryId);
          const fields = changedStoryMetadata(snapshot.current, preview);
          if (fields.length) job.result = { ...job.result, metadataReview: { ...snapshot, incoming: preview, fields, previousState: 'paused' } };
        }
        const replacement = job.kind === 'replacement' ? job.result?.replacement : undefined;
        await tx
          .update(sources)
          .set({
            state: job.result?.metadataReview ? 'review_required' : 'paused',
            ...(job.result?.metadataReview ? { attentionCode: 'metadata_review_required' } : {}),
            nextCheckAt: null,
            lastUpdatedAt: sql`now()`,
            updatedAt: sql`now()`,
            version: sql`${sources.version} + 1`,
            ...(replacement?.identityMatches
              ? { title: replacement.title, authors: replacement.authors, chapterCount: replacement.chapterCount }
              : {}),
            ...(preview && job.kind !== 'rollback'
              ? { title: preview.title, authors: preview.authors, chapterCount: preview.chapterCount, storyStatus: preview.status }
              : {}),
          })
          .where(eq(sources.id, source.id));
      }
      const kind = job.kind === 'rollback' ? 'rolled_back' : 'updated';
      await recordFanfictionActivity(tx, {
        libraryId: job.libraryId,
        userId: job.userId,
        sourceId: source.id,
        jobId: job.id,
        eventKey: `${job.id}:${kind}`,
        kind: job.result?.metadataReview ? 'attention' : kind,
        errorCode: job.result?.metadataReview ? 'metadata_review_required' : null,
        title: source.title,
        bookId: source.bookId,
        revisionId,
      });
    }
    await tx
      .update(jobs)
      .set({
        state: 'succeeded',
        errorCode: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        result: { ...job.result, revisionId, bookFileId, ...(source ? { sourceId: source.id, bookId: source.bookId ?? undefined } : {}) },
        updatedAt: sql`now()`,
      })
      .where(eq(jobs.id, job.id));
  }
}

import { TagMatchingService } from '../tag-matching/tag-matching.service';
import { ForbiddenException, ServiceUnavailableException, HttpException, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { FanfictionJob } from '@bookorbit/types';
import { UserService } from '../user/user.service';
import { shouldRetryJob } from './fanfiction-download-retry';
import { FanfictionJobService } from './fanfiction-job.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { withFanfictionDefaults } from './fanfiction-defaults';
import { FanfictionConnectionService } from './fanfiction-connection.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { FanfictionImportService } from './fanfiction-import.service';
import { FanfictionUpdateService } from './fanfiction-update.service';
import { FanfictionRollbackService } from './fanfiction-rollback.service';
import { FanfictionDiscoveryService } from './fanfiction-discovery.service';
import { FanfictionAdoptionService } from './fanfiction-adoption.service';
import { FanfictionReplacementService } from './fanfiction-replacement.service';
import { FanfictionSourceBatchService } from './fanfiction-source-batch.service';

type ClaimedJob = NonNullable<Awaited<ReturnType<FanfictionJobService['claim']>>>;

@Injectable()
export class FanfictionWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(FanfictionWorkerService.name);
  private readonly active = new Map<AbortController, Promise<void>>();
  private claiming = false;
  private closing = false;

  constructor(
    private readonly tagMatching: TagMatchingService,
    private readonly jobs: FanfictionJobService,
    private readonly access: FanfictionAccessService,
    private readonly connections: FanfictionConnectionService,
    private readonly runtime: FanficfareRuntimeService,
    private readonly users: UserService,
    private readonly imports: FanfictionImportService,
    private readonly updates: FanfictionUpdateService,
    private readonly rollbacks: FanfictionRollbackService,
    private readonly discovery: FanfictionDiscoveryService,
    private readonly adoption: FanfictionAdoptionService,
    private readonly sourceBatches: FanfictionSourceBatchService,
    private readonly replacements: FanfictionReplacementService,
  ) {}

  @Interval(2000)
  async tick(): Promise<void> {
    if (this.closing || this.claiming || this.active.size >= 2) return;
    this.claiming = true;
    try {
      while (!this.closing && this.active.size < 2) {
        const job = await this.jobs.claim();
        if (!job || this.closing) break;
        const startedAt = Date.now();
        const controller = new AbortController();
        const task = this.run(job, controller)
          .catch(() => {
            this.logger.error(
              `[fanfiction.job] [fail] jobId=${job.id} libraryId=${job.libraryId} durationMs=${Date.now() - startedAt} errorClass=WorkerError - worker could not finalize the job`,
            );
          })
          .finally(() => this.active.delete(controller));
        this.active.set(controller, task);
      }
    } finally {
      this.claiming = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled(this.active.values());
  }

  private async authorized(job: ClaimedJob) {
    const user = await this.users.findByIdWithPermissions(job.userId);
    if (!user || user.tokenVersion !== job.tokenVersion) throw new ForbiddenException('Queued operation access was revoked');
    await this.access.administer(user, job.libraryId);
    return user;
  }

  private async run(job: ClaimedJob, controller: AbortController): Promise<void> {
    const startedAt = Date.now();
    let connection: { id: string; generation: number } | null = null;
    let websiteSite: string | undefined;
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void (async () => {
        await this.authorized(job);
        if (!(await this.jobs.renew(job))) controller.abort();
      })()
        .catch(() => controller.abort())
        .finally(() => {
          renewing = false;
        });
    }, 15_000);
    this.logger.log(
      `[fanfiction.job] [start] jobId=${job.id} libraryId=${job.libraryId} userId=${job.userId} kind=${job.kind} attempt=${job.attempts} - job started`,
    );
    try {
      const user = await this.authorized(job);
      const authorizeCookies = async () => {
        const current = await this.authorized(job);
        if (controller.signal.aborted || !(await this.jobs.renew(job)))
          throw new ServiceUnavailableException({ errorCode: 'worker_lease_expired', message: 'Queued operation lease was lost' });
        return current;
      };
      const stalePrepared =
        !!job.result?.preparedUpdate?.approved && !(await this.tagMatching.isCurrent(job.libraryId, job.result.preview?.labelMappingVersion));
      const downloads =
        (!job.result?.preparedUpdate?.approved || stalePrepared) &&
        !['rollback', 'discovery', 'adopt', 'source_batch', 'replacement'].includes(job.kind);
      // Resolve at execution time so already queued stories use a repaired website login.
      const loadWebsite = async () => {
        const session = await this.connections.session(job.url, user, authorizeCookies);
        connection = session.connection ?? null;
        websiteSite = session.site;
        const policy = await this.tagMatching.runtimePolicy(job.libraryId);
        return { document: policy ? { ...session.document, tagMatching: policy } : session.document, saveCookies: session.saveCookies };
      };
      const { document, saveCookies } = downloads
        ? await loadWebsite()
        : {
            document: withFanfictionDefaults({ configuration: '', cookies: [] }, user),
            saveCookies: undefined,
          };
      const result: FanfictionJob['result'] =
        job.kind === 'replacement'
          ? await this.replacements.run(job, () => this.authorized(job), controller.signal)
          : job.kind === 'source_batch'
            ? await this.sourceBatches.run(job, user, () => this.authorized(job), controller.signal)
            : job.kind === 'discovery'
              ? await this.discovery.run(job, () => this.authorized(job), controller.signal)
              : job.kind === 'adopt'
                ? await this.adoption.run(job, user, () => this.authorized(job), controller.signal)
                : job.kind === 'rollback'
                  ? await this.rollbacks.run(job, () => this.authorized(job), controller.signal)
                  : job.kind === 'import'
                    ? await this.imports.run(
                        job,
                        user,
                        document,
                        () => this.authorized(job),
                        controller.signal,
                        saveCookies,
                        (progress) => this.jobs.reportProgress(job, progress),
                      )
                    : job.kind === 'update' || job.kind === 'refresh'
                      ? await this.updates.run(
                          job,
                          document,
                          () => this.authorized(job),
                          controller.signal,
                          saveCookies,
                          (progress) => this.jobs.reportProgress(job, progress),
                          downloads ? undefined : loadWebsite,
                        )
                      : { preview: await this.runtime.preview(job.url, document, controller.signal, saveCookies) };
      await this.authorized(job);
      if (connection) await this.connections.outcome(connection, job.userId);
      const continuation = result?.discovery?.finished === false || result?.selection?.finished === false;
      const storyReview =
        result?.contentReview && !result.contentReview.approved
          ? 'content_review_required'
          : result?.metadataReview && !result.preparedUpdate?.approved
            ? 'metadata_review_required'
            : result?.importReview && !result.importReview.approved
              ? 'import_review_required'
              : null;
      const needsReview = !!storyReview || (result?.selection?.failed ?? 0) > 0;
      if (job.sourceId && result?.bookFileId && !needsReview && ['import', 'update', 'refresh'].includes(job.kind)) {
        const scope = { libraryId: job.libraryId, userId: job.userId, sourceId: job.sourceId };
        if (await this.jobs.renew(job)) await this.runtime.releaseChapters(scope);
      }
      const committed = continuation
        ? await this.jobs.yieldBatch(job, result)
        : await this.jobs.finish(
            job,
            needsReview ? 'review_required' : result?.noChange ? 'no_change' : 'succeeded',
            result,
            needsReview ? (storyReview ?? (job.kind === 'source_batch' ? 'source_batch_review_required' : 'discovery_review_required')) : null,
          );
      this.logger.log(
        `[fanfiction.job] [end] jobId=${job.id} libraryId=${job.libraryId} durationMs=${Date.now() - startedAt} committed=${committed} - job completed`,
      );
    } catch (error) {
      const response = error instanceof HttpException ? error.getResponse() : null;
      const code =
        typeof response === 'object' && response && 'errorCode' in response && typeof response.errorCode === 'string'
          ? response.errorCode
          : job.kind === 'import'
            ? 'import_failed'
            : 'runtime_failed';
      const blocked =
        error instanceof ForbiddenException ||
        [
          'configuration_blocked',
          'authentication_required',
          'adult_confirmation_required',
          'access_denied',
          'fanfiction_net_browser_verification',
          'storiesonline_membership_expired',
        ].includes(code);
      if (connection) await this.connections.outcome(connection, job.userId, code);
      await this.jobs.finish(
        job,
        blocked
          ? 'configuration_blocked'
          : [
                'review_required',
                'source_identity_mismatch',
                'source_chapter_reduction',
                'saved_epub_changed',
                'import_source_changed',
                'metadata_review_required',
                'content_review_required',
                'replacement_identity_mismatch',
                'replacement_chapter_reduction',
                'replacement_revision_changed',
                'replacement_upload_missing',
              ].includes(code)
            ? 'review_required'
            : shouldRetryJob(
                  job.kind,
                  job.attempts,
                  code,
                  (code === 'import_failed' || code === 'runtime_failed') &&
                    (controller.signal.aborted || !(error instanceof HttpException) || error.getStatus() >= 500),
                )
              ? 'queued'
              : 'failed',
        null,
        blocked && error instanceof ForbiddenException ? 'access_revoked' : code,
        websiteSite ? { site: websiteSite, connection } : undefined,
      );
      this.logger.warn(
        `[fanfiction.job] [fail] jobId=${job.id} libraryId=${job.libraryId} durationMs=${Date.now() - startedAt} errorClass=${error instanceof ForbiddenException ? 'ForbiddenException' : 'RuntimeError'} errorCode=${code.replace(/[^a-z_]/g, '').slice(0, 80)} - job did not complete`,
      );
    } finally {
      clearInterval(timer);
    }
  }
}

import { ForbiddenException, HttpException, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { FanfictionJob } from '@bookorbit/types';
import { UserService } from '../user/user.service';
import { FanfictionJobService } from './fanfiction-job.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionProfileService } from './fanfiction-profile.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { FanfictionImportService } from './fanfiction-import.service';
import { FanfictionUpdateService } from './fanfiction-update.service';
import { FanfictionRollbackService } from './fanfiction-rollback.service';
import { FanfictionDiscoveryService } from './fanfiction-discovery.service';
import { FanfictionAdoptionService } from './fanfiction-adoption.service';

type ClaimedJob = NonNullable<Awaited<ReturnType<FanfictionJobService['claim']>>>;

@Injectable()
export class FanfictionWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(FanfictionWorkerService.name);
  private readonly active = new Map<AbortController, Promise<void>>();
  private claiming = false;
  private closing = false;

  constructor(
    private readonly jobs: FanfictionJobService,
    private readonly access: FanfictionAccessService,
    private readonly profiles: FanfictionProfileService,
    private readonly runtime: FanficfareRuntimeService,
    private readonly users: UserService,
    private readonly imports: FanfictionImportService,
    private readonly updates: FanfictionUpdateService,
    private readonly rollbacks: FanfictionRollbackService,
    private readonly discovery: FanfictionDiscoveryService,
    private readonly adoption: FanfictionAdoptionService,
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
      const document =
        job.profileId && !['rollback', 'discovery', 'adopt'].includes(job.kind)
          ? (await this.profiles.document(job.libraryId, job.profileId, user)).document
          : { configuration: '', cookies: [] };
      const result: FanfictionJob['result'] =
        job.kind === 'discovery'
          ? await this.discovery.run(job, () => this.authorized(job), controller.signal)
          : job.kind === 'adopt'
            ? await this.adoption.run(job, user, () => this.authorized(job), controller.signal)
            : job.kind === 'rollback'
              ? await this.rollbacks.run(job, () => this.authorized(job), controller.signal)
              : job.kind === 'import'
                ? await this.imports.run(job, user, document, () => this.authorized(job), controller.signal)
                : job.kind === 'update' || job.kind === 'refresh'
                  ? await this.updates.run(job, document, () => this.authorized(job), controller.signal)
                  : { preview: await this.runtime.preview(job.url, document, controller.signal) };
      await this.authorized(job);
      const continuation = result?.discovery?.finished === false || result?.selection?.finished === false;
      const needsReview = (result?.selection?.failed ?? 0) > 0;
      const committed = continuation
        ? await this.jobs.yieldBatch(job, result)
        : await this.jobs.finish(
            job,
            needsReview ? 'review_required' : result?.noChange ? 'no_change' : 'succeeded',
            result,
            needsReview ? 'discovery_review_required' : null,
          );
      this.logger.log(
        `[fanfiction.job] [end] jobId=${job.id} libraryId=${job.libraryId} durationMs=${Date.now() - startedAt} committed=${committed} - job completed`,
      );
    } catch (error) {
      const response = error instanceof HttpException ? error.getResponse() : null;
      const code =
        typeof response === 'object' && response && 'errorCode' in response && typeof response.errorCode === 'string'
          ? response.errorCode
          : 'runtime_failed';
      const blocked = error instanceof ForbiddenException || ['configuration_blocked', 'authentication_required'].includes(code);
      await this.jobs.finish(
        job,
        blocked ? 'configuration_blocked' : code === 'review_required' ? 'review_required' : job.attempts < 3 ? 'queued' : 'failed',
        null,
        blocked && error instanceof ForbiddenException ? 'access_revoked' : code,
      );
      this.logger.warn(
        `[fanfiction.job] [fail] jobId=${job.id} libraryId=${job.libraryId} durationMs=${Date.now() - startedAt} errorClass=${error instanceof ForbiddenException ? 'ForbiddenException' : 'RuntimeError'} - job did not complete`,
      );
    } finally {
      clearInterval(timer);
    }
  }
}

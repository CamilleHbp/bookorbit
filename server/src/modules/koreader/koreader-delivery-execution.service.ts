import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash, randomUUID } from 'node:crypto';
import type { KoreaderDeliveryFailure, KoreaderDeliveryLease, KoreaderPublicationPermit, RevisionPositionAcknowledgement } from '@bookorbit/types';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { RequestUser } from '../../common/types/request-user';
import { RevisionDownloadService } from '../book-revision/revision-download.service';
import { KoreaderDeliveryAccessService } from './koreader-delivery-access.service';
import { deliveryView } from './koreader-delivery-view';
import type { ClaimKoreaderDeliveryDto, KoreaderDeliveryLeaseDto, KoreaderDeliveryProgressDto } from './dto/koreader-delivery.dto';

const jobs = schema.koreaderDeliveryJobs,
  copies = schema.koreaderInstalledCopies;
const LEASE_MS = 300_000;

class DeliveryBlockedException extends ConflictException {
  constructor(
    readonly failureCode: KoreaderDeliveryFailure,
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class KoreaderDeliveryExecutionService {
  private readonly logger = new Logger(KoreaderDeliveryExecutionService.name);
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly access: KoreaderDeliveryAccessService,
    private readonly downloads: RevisionDownloadService,
  ) {}

  private async context(id: string, deviceId: string, user: RequestUser) {
    const [job] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
      .limit(1);
    if (!job) throw new NotFoundException('Delivery unavailable');
    const context = await this.access.copy(job.installedCopyId, user, true, deviceId);
    return { ...context, job };
  }

  private requireTarget(context: Awaited<ReturnType<KoreaderDeliveryExecutionService['context']>>) {
    const { job, copy, device, file } = context;
    if (job.cancelledAt || job.failureCode || job.installationState === 'installed') throw new ConflictException('Delivery is no longer active');
    if (device.deliveryCapabilityVersion < 1 || device.positionCapabilityVersion < 1)
      throw new DeliveryBlockedException('configuration_blocked', 'A compatible plugin update is required');
    if (
      file.libraryId !== job.libraryId ||
      file.currentRevisionId !== job.revisionId ||
      file.sha256 !== job.sha256 ||
      file.sizeBytes !== job.sizeBytes
    )
      throw new DeliveryBlockedException('revision_changed', 'The expected server revision changed');
    if (copy.pathname !== job.pathname || copy.sha256 !== job.expectedLocalSha256 || copy.sizeBytes !== job.expectedLocalSizeBytes)
      throw new DeliveryBlockedException('copy_changed', 'The installed copy changed');
    if (
      job.mode === 'automatic' &&
      ((copy.policy ?? device.policy) !== 'automatic' || copy.policyAcknowledgement !== `${device.policyVersion}:${copy.policyVersion}`)
    )
      throw new DeliveryBlockedException('configuration_blocked', 'Automatic delivery policy changed');
  }

  private async perform<T>(id: string, user: RequestUser, phase: string, operation: () => Promise<T>, fence?: number) {
    const started = Date.now();
    this.logger.log(`[koreader.delivery_${phase}] [start] jobId=${id} userId=${user.id} - device delivery operation started`);
    try {
      const result = await operation();
      this.logger.log(
        `[koreader.delivery_${phase}] [end] jobId=${id} userId=${user.id} durationMs=${Date.now() - started} - device delivery operation completed`,
      );
      return result;
    } catch (error) {
      await this.recordBlockedFailure(id, user.id, error, fence);
      this.logger.warn(
        `[koreader.delivery_${phase}] [fail] jobId=${id} userId=${user.id} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : 'Delivery failed')}" - device delivery operation failed`,
      );
      throw error;
    }
  }

  private async recordBlockedFailure(id: string, userId: number, error: unknown, fence?: number) {
    const failureCode = error instanceof DeliveryBlockedException ? error.failureCode : error instanceof ForbiddenException ? 'access_revoked' : null;
    if (!failureCode) return;
    await this.db
      .update(jobs)
      .set({ failureCode, version: sql`${jobs.version} + 1`, updatedAt: sql`now()` })
      .where(
        and(
          eq(jobs.id, id),
          eq(jobs.userId, userId),
          fence === undefined ? undefined : eq(jobs.fence, fence),
          isNull(jobs.failureCode),
          isNull(jobs.cancelledAt),
          ne(jobs.installationState, 'installed'),
        ),
      );
  }

  claim(id: string, dto: ClaimKoreaderDeliveryDto, user: RequestUser) {
    return this.perform(id, user, 'claim', () => this.claimOwned(id, dto, user));
  }
  progress(id: string, dto: KoreaderDeliveryProgressDto, user: RequestUser) {
    return this.perform(id, user, 'progress', () => this.progressOwned(id, dto, user), dto.fence);
  }
  authorizePublication(id: string, dto: KoreaderDeliveryLeaseDto, user: RequestUser) {
    return this.perform(id, user, 'publication', () => this.authorizeOwned(id, dto, user), dto.fence);
  }
  download(id: string, dto: KoreaderDeliveryLeaseDto, user: RequestUser, cancelled: () => boolean) {
    return this.perform(id, user, 'download', () => this.downloadOwned(id, dto, user, cancelled), dto.fence);
  }

  private requireLease(job: typeof jobs.$inferSelect, dto: KoreaderDeliveryLeaseDto, allowExpired = false) {
    if (job.leaseToken !== dto.token || job.fence !== dto.fence || !job.leaseExpiresAt || (!allowExpired && job.leaseExpiresAt <= new Date()))
      throw new ConflictException('Delivery lease expired or was replaced');
  }

  private async claimOwned(id: string, dto: ClaimKoreaderDeliveryDto, user: RequestUser): Promise<KoreaderDeliveryLease> {
    const context = await this.context(id, dto.deviceId, user);
    this.requireTarget(context);
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
        .for('update');
      if (!job) throw new NotFoundException('Delivery unavailable');
      this.requireTarget({ ...context, job });
      if (job.leaseToken && job.leaseExpiresAt && job.leaseExpiresAt > new Date()) {
        if (job.claimId !== dto.claimId) throw new ConflictException('Another worker owns this delivery');
        return { job: deliveryView(job, context.copy), token: job.leaseToken, fence: job.fence, expiresAt: job.leaseExpiresAt.toISOString() };
      }
      const [claimed] = await tx
        .update(jobs)
        .set({
          leaseToken: randomUUID(),
          claimId: dto.claimId,
          fence: sql`${jobs.fence} + 1`,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          installationState: 'waiting_for_uploads',
          reportSequence: 0,
          reportHash: null,
          publicationToken: null,
          publicationExpiresAt: null,
          version: sql`${jobs.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(jobs.id, id))
        .returning();
      return {
        job: deliveryView(claimed, context.copy),
        token: claimed.leaseToken!,
        fence: claimed.fence,
        expiresAt: claimed.leaseExpiresAt!.toISOString(),
      };
    });
  }

  private async progressOwned(id: string, dto: KoreaderDeliveryProgressDto, user: RequestUser) {
    const context = await this.context(id, dto.deviceId, user);
    const reportHash = createHash('sha256')
      .update(
        JSON.stringify([
          dto.sequence,
          dto.state,
          dto.localSha256,
          dto.localSizeBytes,
          dto.pathname,
          dto.readingUploadsComplete,
          dto.publicationToken ?? null,
          dto.failureCode ?? null,
        ]),
      )
      .digest('hex');
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
        .for('update');
      if (!job) throw new NotFoundException('Delivery unavailable');
      this.requireLease(job, dto, dto.state === 'installed');
      if (dto.sequence === job.reportSequence && job.reportHash === reportHash) return deliveryView(job, context.copy);
      if (dto.sequence <= job.reportSequence) throw new ConflictException('Delivery report is stale or conflicting');
      if (dto.pathname !== job.pathname) throw new ConflictException('Installed pathname does not match the delivery');
      if (dto.state === 'installed') {
        if (
          job.installationState !== 'downloading' ||
          !job.publicationToken ||
          dto.publicationToken !== job.publicationToken ||
          dto.localSha256 !== job.sha256 ||
          dto.localSizeBytes !== job.sizeBytes ||
          !dto.readingUploadsComplete ||
          dto.failureCode
        )
          throw new ConflictException('Installation does not match the authorized revision');
      } else {
        this.requireTarget({ ...context, job });
        if (dto.localSha256 !== job.expectedLocalSha256 || dto.localSizeBytes !== job.expectedLocalSizeBytes)
          throw new ConflictException('Local file changed before installation');
        if (dto.state === 'waiting_for_uploads' && job.installationState !== 'waiting_for_uploads')
          throw new ConflictException('Delivery cannot return to uploads without a new claim');
        if (dto.state === 'waiting_for_close' && !['waiting_for_uploads', 'waiting_for_close'].includes(job.installationState))
          throw new ConflictException('Delivery has already started downloading');
        if (dto.state !== 'waiting_for_uploads' && !dto.readingUploadsComplete)
          throw new ConflictException('Pending reading data must finish uploading first');
      }
      const [updated] = await tx
        .update(jobs)
        .set({
          installationState: dto.state,
          failureCode: dto.failureCode ?? null,
          reportSequence: dto.sequence,
          reportHash,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          ...(dto.state === 'installed' ? { installedAt: sql`now()`, restorationState: 'verification_pending' as const } : {}),
          version: sql`${jobs.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(jobs.id, id))
        .returning();
      return deliveryView(updated, context.copy);
    });
  }

  private async authorizeOwned(id: string, dto: KoreaderDeliveryLeaseDto, user: RequestUser): Promise<KoreaderPublicationPermit> {
    const context = await this.context(id, dto.deviceId, user);
    this.requireTarget(context);
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
        .for('update');
      if (!job) throw new NotFoundException('Delivery unavailable');
      this.requireTarget({ ...context, job });
      this.requireLease(job, dto);
      if (job.installationState !== 'downloading') throw new ConflictException('Delivery has not completed the upload prerequisites');
      if (job.publicationToken && job.publicationExpiresAt && job.publicationExpiresAt > new Date())
        return {
          token: job.publicationToken,
          expiresAt: job.publicationExpiresAt.toISOString(),
          validForMs: Math.max(0, job.publicationExpiresAt.getTime() - Date.now()),
          revisionId: job.revisionId,
          sha256: job.sha256,
          sizeBytes: job.sizeBytes,
        };
      const [authorized] = await tx
        .update(jobs)
        .set({
          publicationToken: randomUUID(),
          publicationExpiresAt: new Date(Date.now() + 30_000),
          version: sql`${jobs.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(jobs.id, id))
        .returning();
      return {
        token: authorized.publicationToken!,
        expiresAt: authorized.publicationExpiresAt!.toISOString(),
        validForMs: Math.max(0, authorized.publicationExpiresAt!.getTime() - Date.now()),
        revisionId: authorized.revisionId,
        sha256: authorized.sha256,
        sizeBytes: authorized.sizeBytes,
      };
    });
  }

  private async downloadOwned(id: string, dto: KoreaderDeliveryLeaseDto, user: RequestUser, cancelled: () => boolean) {
    const context = await this.context(id, dto.deviceId, user);
    this.requireTarget(context);
    this.requireLease(context.job, dto);
    if (context.job.installationState !== 'downloading') throw new ConflictException('Reading uploads must finish before downloading');
    return this.downloads.download(context.copy.bookFileId, context.job.libraryId, context.job.revisionId, async () => {
      try {
        if (cancelled()) throw new ServiceUnavailableException('Device download was cancelled');
        const current = await this.context(id, dto.deviceId, user);
        this.requireTarget(current);
        this.requireLease(current.job, dto);
      } catch (error) {
        await this.recordBlockedFailure(id, user.id, error, dto.fence);
        throw error;
      }
    });
  }

  async acknowledgeRestoration(userId: number, fileId: number, deviceId: string, copyId: string, acknowledgement: RevisionPositionAcknowledgement) {
    const [copy] = await this.db
      .select({ id: copies.id })
      .from(copies)
      .where(and(eq(copies.userId, userId), eq(copies.bookFileId, fileId), eq(copies.deviceId, deviceId), eq(copies.copyId, copyId)))
      .limit(1);
    if (!copy) return;
    const [job] = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.userId, userId),
          eq(jobs.installedCopyId, copy.id),
          eq(jobs.installationState, 'installed'),
          acknowledgement.revision.startsWith('sha256:')
            ? eq(jobs.sha256, acknowledgement.revision.slice(7))
            : eq(jobs.revisionId, acknowledgement.revision),
        ),
      )
      .orderBy(desc(jobs.installedAt), desc(jobs.id))
      .limit(1);
    if (!job) return;
    await this.db
      .update(jobs)
      .set({
        restorationState: acknowledgement.quality === 'approximate' ? 'approximate' : 'verified',
        restorationFailureCode: null,
        restoredAt: sql`now()`,
        version: sql`${jobs.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(jobs.id, job.id), inArray(jobs.restorationState, ['verification_pending', 'failed'])));
  }
}

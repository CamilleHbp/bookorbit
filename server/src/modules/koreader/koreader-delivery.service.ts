import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { and, desc, eq, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { KoreaderDeliveryJobPage, KoreaderDeliveryTargets, RequestKoreaderDelivery } from '@bookorbit/types';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { RequestUser } from '../../common/types/request-user';
import { BookReadService } from '../book/book-read.service';
import { KoreaderDeliveryAccessService } from './koreader-delivery-access.service';
import { deliveryView } from './koreader-delivery-view';
import { ListKoreaderDeliveriesDto } from './dto/koreader-delivery.dto';

const jobs = schema.koreaderDeliveryJobs,
  copies = schema.koreaderInstalledCopies,
  devices = schema.koreaderDeliveryDevices;

@Injectable()
export class KoreaderDeliveryService {
  private readonly logger = new Logger(KoreaderDeliveryService.name);
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly access: KoreaderDeliveryAccessService,
    private readonly books: BookReadService,
  ) {}

  request(copyId: string, dto: RequestKoreaderDelivery, user: RequestUser, mode: 'manual' | 'automatic' = 'manual') {
    return this.perform('request', copyId, user, () => this.requestOwned(copyId, dto, user, mode));
  }
  async targets(fileIds: number[], user: RequestUser): Promise<KoreaderDeliveryTargets> {
    const fresh = await this.access.user(user);
    const files = await this.books.findAccessibleFiles(fileIds, fresh);
    return {
      items: files.flatMap((file) =>
        ['epub', 'kepub'].includes(file.format) && file.currentRevisionId && file.sha256 && file.sizeBytes !== null
          ? [{ bookFileId: file.id, bookId: file.bookId, revisionId: file.currentRevisionId, sha256: file.sha256, sizeBytes: file.sizeBytes }]
          : [],
      ),
    };
  }
  cancel(id: string, version: number, user: RequestUser) {
    return this.perform('cancel', id, user, () => this.cancelOwned(id, version, user));
  }
  retry(id: string, version: number, user: RequestUser) {
    return this.perform('retry', id, user, () => this.retryOwned(id, version, user));
  }
  private async perform<T>(operation: string, id: string, user: RequestUser, run: () => Promise<T>) {
    const startedAt = Date.now();
    this.logger.log(`[koreader.delivery_${operation}] [start] id=${id} userId=${user.id} - delivery change started`);
    try {
      const result = await run();
      this.logger.log(
        `[koreader.delivery_${operation}] [end] id=${id} userId=${user.id} durationMs=${Date.now() - startedAt} - delivery change completed`,
      );
      return result;
    } catch (error) {
      this.logger.warn(
        `[koreader.delivery_${operation}] [fail] id=${id} userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : 'Delivery failed')}" - delivery change failed`,
      );
      throw error;
    }
  }
  private async requestOwned(copyId: string, dto: RequestKoreaderDelivery, user: RequestUser, mode: 'manual' | 'automatic') {
    const context = await this.access.copy(copyId, user);
    return this.db.transaction(async (tx) => {
      const [device] = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.userId, user.id), eq(devices.deviceId, context.copy.deviceId)))
        .for('update');
      const [copy] = await tx
        .select()
        .from(copies)
        .where(and(eq(copies.id, copyId), eq(copies.userId, user.id)))
        .for('update');
      if (!copy || !device) throw new NotFoundException('Installed copy unavailable');
      const [sameRequest] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.userId, user.id), eq(jobs.requestKey, dto.idempotencyKey)))
        .limit(1);
      if (sameRequest) {
        if (sameRequest.installedCopyId !== copyId || sameRequest.revisionId !== dto.expectedRevisionId)
          throw new ConflictException('Delivery request identity was reused');
        return deliveryView(sameRequest, copy);
      }
      const [existing] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.userId, user.id), eq(jobs.installedCopyId, copyId), eq(jobs.revisionId, dto.expectedRevisionId)))
        .limit(1);
      if (existing) return deliveryView(existing, copy);
      if (context.file.currentRevisionId !== dto.expectedRevisionId || !context.file.sha256 || context.file.sizeBytes === null)
        throw new ConflictException('The expected revision is no longer available');
      if (context.copy.sha256 !== copy.sha256 || context.copy.pathname !== copy.pathname)
        throw new ConflictException('The installed copy changed; refresh before requesting delivery');
      if (copy.sha256 === context.file.sha256 && copy.sizeBytes === context.file.sizeBytes)
        throw new ConflictException('This copy already matches the server file');
      if (device.deliveryCapabilityVersion < 1 || device.positionCapabilityVersion < 1)
        throw new ConflictException('A compatible plugin update is required');
      if (
        mode === 'automatic' &&
        ((copy.policy ?? device.policy) !== 'automatic' ||
          !copy.revisionId ||
          copy.policyAcknowledgement !== `${device.policyVersion}:${copy.policyVersion}`)
      )
        throw new ConflictException('Automatic delivery is not acknowledged for this copy');
      const [active] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.installedCopyId, copyId), isNull(jobs.cancelledAt), isNull(jobs.failureCode), ne(jobs.installationState, 'installed')))
        .limit(1);
      if (active) throw new ConflictException('Another delivery is active for this copy');
      const [job] = await tx
        .insert(jobs)
        .values({
          userId: user.id,
          installedCopyId: copyId,
          libraryId: context.file.libraryId,
          revisionId: dto.expectedRevisionId,
          requestKey: dto.idempotencyKey,
          sha256: context.file.sha256,
          sizeBytes: context.file.sizeBytes,
          expectedLocalSha256: copy.sha256,
          expectedLocalSizeBytes: copy.sizeBytes,
          pathname: copy.pathname,
          mode,
        })
        .onConflictDoNothing()
        .returning();
      if (!job) throw new ConflictException('Delivery identity conflicts with an existing request');
      return deliveryView(job, copy);
    });
  }

  async get(id: string, user: RequestUser, deviceId?: string) {
    const [job] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
      .limit(1);
    if (!job) throw new NotFoundException('Delivery unavailable');
    const context = await this.access.copy(job.installedCopyId, user, false, deviceId);
    return deliveryView(job, context.copy);
  }

  async list(query: ListKoreaderDeliveriesDto, user: RequestUser): Promise<KoreaderDeliveryJobPage> {
    const fresh = await this.access.user(user, false);
    const filters = and(
      eq(jobs.userId, fresh.id),
      query.installedCopyId ? eq(jobs.installedCopyId, query.installedCopyId) : undefined,
      query.deviceId ? eq(copies.deviceId, query.deviceId) : undefined,
    );
    const availability = query.activeOnly
      ? and(isNull(jobs.cancelledAt), isNull(jobs.failureCode), ne(jobs.installationState, 'installed'))
      : undefined;
    let after: SQL | undefined;
    if (query.cursor) {
      const [cursor] = await this.db
        .select({ id: jobs.id, createdAt: jobs.createdAt })
        .from(jobs)
        .innerJoin(copies, eq(copies.id, jobs.installedCopyId))
        .where(and(filters, eq(jobs.id, query.cursor)))
        .limit(1);
      if (!cursor) throw new NotFoundException('Delivery cursor unavailable');
      after = or(lt(jobs.createdAt, cursor.createdAt), and(eq(jobs.createdAt, cursor.createdAt), lt(jobs.id, cursor.id)));
    }
    const rows = await this.db
      .select({ job: jobs, copy: copies })
      .from(jobs)
      .innerJoin(copies, eq(copies.id, jobs.installedCopyId))
      .where(and(filters, availability, after))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const accessible = new Set(
      (await this.books.findAccessibleFiles([...new Set(page.map((row) => row.copy.bookFileId))], fresh)).map((file) => file.id),
    );
    return {
      items: page.filter((row) => accessible.has(row.copy.bookFileId)).map((row) => deliveryView(row.job, row.copy)),
      nextCursor: rows.length > query.limit ? page.at(-1)!.job.id : null,
    };
  }

  private async cancelOwned(id: string, version: number, user: RequestUser) {
    const current = await this.get(id, user);
    const [updated] = await this.db
      .update(jobs)
      .set({ cancelledAt: sql`now()`, version: sql`${jobs.version} + 1`, updatedAt: sql`now()` })
      .where(and(eq(jobs.id, id), eq(jobs.userId, user.id), eq(jobs.version, version), ne(jobs.installationState, 'installed')))
      .returning();
    if (!updated) throw new ConflictException('Delivery changed; refresh before cancelling');
    return deliveryView(updated, current);
  }

  private async retryOwned(id: string, version: number, user: RequestUser) {
    const current = await this.get(id, user);
    const context = await this.access.copy(current.installedCopyId, user);
    if (context.file.currentRevisionId !== current.revisionId) throw new ConflictException('Request the current revision instead');
    return this.db.transaction(async (tx) => {
      const [copy] = await tx
        .select()
        .from(copies)
        .where(and(eq(copies.id, current.installedCopyId), eq(copies.userId, user.id)))
        .for('update');
      if (!copy || copy.bookFileId !== context.copy.bookFileId) throw new NotFoundException('Installed copy unavailable');
      const [job] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
        .for('update');
      if (!job || job.version !== version || job.installationState === 'installed' || (!job.cancelledAt && !job.failureCode))
        throw new ConflictException('Delivery is not retryable in its current state');
      if (job.publicationExpiresAt && job.publicationExpiresAt > new Date())
        throw new ConflictException('Wait for the existing publication permission to expire before retrying');
      const [active] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.installedCopyId, job.installedCopyId),
            ne(jobs.id, id),
            isNull(jobs.cancelledAt),
            isNull(jobs.failureCode),
            ne(jobs.installationState, 'installed'),
          ),
        )
        .limit(1);
      if (active) throw new ConflictException('Another delivery is active for this copy');
      const [updated] = await tx
        .update(jobs)
        .set({
          cancelledAt: null,
          failureCode: null,
          installationState: 'requested',
          leaseToken: null,
          leaseExpiresAt: null,
          claimId: null,
          publicationToken: null,
          publicationExpiresAt: null,
          reportHash: null,
          reportSequence: 0,
          expectedLocalSha256: copy.sha256,
          expectedLocalSizeBytes: copy.sizeBytes,
          pathname: copy.pathname,
          attempt: sql`${jobs.attempt} + 1`,
          fence: sql`${jobs.fence} + 1`,
          version: sql`${jobs.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(jobs.id, id))
        .returning();
      return deliveryView(updated, context.copy);
    });
  }
}

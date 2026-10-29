import { randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { UserService } from '../user/user.service';
import { KoreaderDeliveryService } from './koreader-delivery.service';

const copies = schema.koreaderInstalledCopies,
  devices = schema.koreaderDeliveryDevices;

@Injectable()
export class KoreaderDeliverySchedulerService {
  private readonly logger = new Logger(KoreaderDeliverySchedulerService.name);
  private running = false;
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly users: UserService,
    private readonly deliveries: KoreaderDeliveryService,
  ) {}

  @Interval(10_000)
  async tick() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      await this.runBatch();
    } catch (error) {
      this.logger.warn(
        `[koreader.delivery_schedule] [fail] durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : 'Scheduling failed')}" - automatic delivery scheduling failed`,
      );
    } finally {
      this.running = false;
    }
  }

  async runBatch() {
    const startedAt = Date.now();
    const claimed = await this.db.transaction(async (tx) => {
      const selected = await tx
        .select({ id: copies.id, userId: copies.userId, bookFileId: copies.bookFileId, sha256: copies.sha256 })
        .from(copies)
        .innerJoin(devices, and(eq(devices.userId, copies.userId), eq(devices.deviceId, copies.deviceId)))
        .where(
          and(
            lte(copies.deliveryCheckAfter, sql`now()`),
            isNotNull(copies.revisionId),
            sql`coalesce(${copies.policy}, ${devices.policy}) = 'automatic'`,
            sql`${devices.deliveryCapabilityVersion} >= 1 and ${devices.positionCapabilityVersion} >= 1`,
            sql`${copies.policyAcknowledgement} = ${devices.policyVersion}::text || ':' || ${copies.policyVersion}::text`,
          ),
        )
        .orderBy(asc(copies.deliveryCheckAfter), asc(copies.id))
        .limit(100)
        .for('update', { of: copies, skipLocked: true });
      if (selected.length)
        await tx
          .update(copies)
          .set({ deliveryCheckAfter: sql`now() + interval '60 seconds'` })
          .where(
            inArray(
              copies.id,
              selected.map((copy) => copy.id),
            ),
          );
      return selected;
    });
    if (!claimed.length) return { checked: 0, requested: 0, unavailable: 0 };
    this.logger.log(`[koreader.delivery_schedule] [start] count=${claimed.length} - automatic delivery scheduling started`);
    const grouped = new Map<number, typeof claimed>();
    for (const copy of claimed) {
      const owned = grouped.get(copy.userId) ?? [];
      owned.push(copy);
      grouped.set(copy.userId, owned);
    }
    let requested = 0,
      unavailable = 0;
    for (const [userId, owned] of grouped) {
      const user = await this.users.findByIdWithPermissions(userId);
      if (!user?.active) {
        unavailable += owned.length;
        continue;
      }
      try {
        const targets = await this.deliveries.targets([...new Set(owned.map((copy) => copy.bookFileId))], user);
        const byFile = new Map(targets.items.map((target) => [target.bookFileId, target]));
        const candidates = owned.filter((copy) => byFile.has(copy.bookFileId) && byFile.get(copy.bookFileId)!.sha256 !== copy.sha256);
        if (!candidates.length) continue;
        const jobs = schema.koreaderDeliveryJobs;
        const existing = await this.db
          .select({ installedCopyId: jobs.installedCopyId })
          .from(jobs)
          .where(
            and(
              eq(jobs.userId, userId),
              or(
                ...candidates.map((copy) =>
                  and(
                    eq(jobs.installedCopyId, copy.id),
                    or(
                      eq(jobs.revisionId, byFile.get(copy.bookFileId)!.revisionId),
                      and(isNull(jobs.cancelledAt), isNull(jobs.failureCode), ne(jobs.installationState, 'installed')),
                    ),
                  ),
                ),
              ),
            ),
          )
          .limit(200);
        const suppressed = new Set(existing.map((job) => job.installedCopyId));
        for (const copy of owned) {
          const target = byFile.get(copy.bookFileId);
          if (!target || target.sha256 === copy.sha256 || suppressed.has(copy.id)) continue;
          try {
            await this.deliveries.request(copy.id, { expectedRevisionId: target.revisionId, idempotencyKey: randomUUID() }, user, 'automatic');
            requested++;
          } catch (error) {
            if (!(error instanceof HttpException) || ![403, 404, 409].includes(error.getStatus())) throw error;
            unavailable++;
          }
        }
      } catch (error) {
        if (!(error instanceof HttpException) || ![403, 404].includes(error.getStatus())) throw error;
        unavailable += owned.length;
      }
    }
    this.logger.log(
      `[koreader.delivery_schedule] [end] durationMs=${Date.now() - startedAt} checked=${claimed.length} requested=${requested} unavailable=${unavailable} - automatic delivery scheduling completed`,
    );
    return { checked: claimed.length, requested, unavailable };
  }
}

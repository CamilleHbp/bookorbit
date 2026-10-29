import { copyInventoryHash, planCopyReports } from './koreader-copy-report';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  Permission,
  type KoreaderCopyInventoryResult,
  type KoreaderInstalledCopyPage,
  type KoreaderDeliveryDevicePage,
  type KoreaderCopyPolicyAcknowledgements,
  type KoreaderCopyPolicyAcknowledgementResult,
} from '@bookorbit/types';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { RequestUser } from '../../common/types/request-user';
import { PermissionService } from '../../common/services/permission.service';
import { BookReadService } from '../book/book-read.service';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';
import {
  KoreaderCopyInventoryDto,
  ListKoreaderCopiesDto,
  ListKoreaderDeliveryDevicesDto,
  UpdateKoreaderCopyPolicyDto,
  UpdateKoreaderDevicePolicyDto,
} from './dto/koreader-copy.dto';

const copies = schema.koreaderInstalledCopies;
const devices = schema.koreaderDeliveryDevices;

@Injectable()
export class KoreaderCopyService {
  private readonly logger = new Logger(KoreaderCopyService.name);
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly books: BookReadService,
    private readonly revisions: RevisionCatalogService,
    private readonly permissions: PermissionService,
  ) {}

  private requireAccess(user: RequestUser, download = false) {
    if (
      !user.active ||
      !this.permissions.userHas(user, Permission.KoreaderSync) ||
      (download && !this.permissions.userHas(user, Permission.LibraryDownload))
    )
      throw new ForbiddenException('KOReader synchronization and applicable download permission are required');
  }

  async acknowledgePolicies(dto: KoreaderCopyPolicyAcknowledgements, user: RequestUser): Promise<KoreaderCopyPolicyAcknowledgementResult> {
    this.requireAccess(user);
    return this.db.transaction(async (tx) => {
      const [device] = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.userId, user.id), eq(devices.deviceId, dto.deviceId)))
        .for('update');
      if (!device || device.deliveryCapabilityVersion < 1 || device.positionCapabilityVersion < 1)
        throw new ConflictException('A compatible plugin update is required');
      const owned = await tx
        .select()
        .from(copies)
        .where(
          and(
            eq(copies.userId, user.id),
            eq(copies.deviceId, dto.deviceId),
            inArray(
              copies.id,
              dto.copies.map((copy) => copy.id),
            ),
          ),
        )
        .for('update');
      const accessible = new Set(
        (await this.books.findAccessibleFiles([...new Set(owned.map((copy) => copy.bookFileId))], user)).map((file) => file.id),
      );
      const versions = new Map(dto.copies.map((copy) => [copy.id, copy.effectivePolicyVersion]));
      const accepted = owned.filter(
        (copy) => accessible.has(copy.bookFileId) && versions.get(copy.id) === `${device.policyVersion}:${copy.policyVersion}`,
      );
      if (accepted.length)
        await tx
          .update(copies)
          .set({
            policyAcknowledgement: sql`${device.policyVersion}::text || ':' || ${copies.policyVersion}::text`,
            deliveryCheckAfter: sql`now()`,
          })
          .where(
            inArray(
              copies.id,
              accepted.map((copy) => copy.id),
            ),
          );
      return { accepted: accepted.map((copy) => copy.id) };
    });
  }

  async report(dto: KoreaderCopyInventoryDto, user: RequestUser): Promise<KoreaderCopyInventoryResult> {
    const startedAt = Date.now();
    const context = `userId=${user.id} deviceId="${sanitizeLogValue(dto.deviceId)}"`;
    this.logger.log(`[koreader.copy_inventory] [start] ${context} count=${dto.copies.length} - copy inventory started`);
    try {
      const result = await this.reportInventory(dto, user);
      const accepted = result.copies.filter((copy) => copy.status === 'accepted').length;
      const rejected = result.copies.filter((copy) => copy.status === 'conflict' || copy.status === 'unavailable').length;
      this.logger.log(
        `[koreader.copy_inventory] [end] ${context} durationMs=${Date.now() - startedAt} accepted=${accepted} rejected=${rejected} - copy inventory completed`,
      );
      return result;
    } catch (error) {
      this.logger.warn(
        `[koreader.copy_inventory] [fail] ${context} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : 'Inventory failed')}" - copy inventory failed`,
      );
      throw error;
    }
  }

  private async reportInventory(dto: KoreaderCopyInventoryDto, user: RequestUser): Promise<KoreaderCopyInventoryResult> {
    this.requireAccess(user);
    const reports = dto.copies.map((copy) => ({ ...copy, copyId: copy.copyId.toLowerCase() }));
    if (new Set(reports.map((copy) => copy.copyId)).size !== reports.length) throw new BadRequestException('Copy identities must be unique');
    const accessible = await this.books.findAccessibleFiles([...new Set(reports.map((copy) => copy.bookFileId))], user);
    const allowed = new Set(accessible.filter((file) => ['epub', 'kepub'].includes(file.format ?? '')).map((file) => file.id));
    const selected = reports.filter((copy) => allowed.has(copy.bookFileId));
    const revisions = await this.revisions.identifyFiles(selected);
    const identity = new Map(selected.map((copy, index) => [copy.copyId, revisions[index] ?? null]));
    return this.db.transaction(async (tx) => {
      await tx
        .insert(devices)
        .values({
          userId: user.id,
          deviceId: dto.deviceId,
          pluginVersion: dto.pluginVersion,
          contactSequence: dto.sequence,
          deliveryCapabilityVersion: dto.deliveryCapabilityVersion,
          positionCapabilityVersion: dto.positionCapabilityVersion,
        })
        .onConflictDoNothing();
      const [device] = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.userId, user.id), eq(devices.deviceId, dto.deviceId)))
        .for('update');
      const deviceInfo =
        dto.sequence > device.contactSequence
          ? {
              pluginVersion: dto.pluginVersion,
              contactSequence: dto.sequence,
              deliveryCapabilityVersion: dto.deliveryCapabilityVersion,
              positionCapabilityVersion: dto.positionCapabilityVersion,
            }
          : {};
      await tx
        .update(devices)
        .set({ ...deviceInfo, lastContactAt: sql`now()` })
        .where(and(eq(devices.userId, user.id), eq(devices.deviceId, dto.deviceId)));
      const paths = reports.map((copy) => copyInventoryHash(copy.pathname));
      const existing = await tx
        .select()
        .from(copies)
        .where(
          and(
            eq(copies.userId, user.id),
            eq(copies.deviceId, dto.deviceId),
            or(
              inArray(
                copies.copyId,
                reports.map((copy) => copy.copyId),
              ),
              inArray(copies.pathnameHash, paths),
            ),
          ),
        )
        .for('update');
      const { writes, results } = planCopyReports(reports, dto.sequence, device, existing, identity, allowed);
      if (writes.length) {
        const saved = await tx
          .insert(copies)
          .values(writes)
          .onConflictDoUpdate({
            target: [copies.userId, copies.deviceId, copies.copyId],
            set: {
              pathname: sql`excluded.pathname`,
              pathnameHash: sql`excluded.pathname_hash`,
              sha256: sql`excluded.sha256`,
              sizeBytes: sql`excluded.size_bytes`,
              revisionId: sql`excluded.revision_id`,
              reportSequence: sql`excluded.report_sequence`,
              reportHash: sql`excluded.report_hash`,
              policyAcknowledgement: sql`excluded.policy_acknowledgement`,
              lastContactAt: sql`now()`,
            },
          })
          .returning({ id: copies.id, copyId: copies.copyId });
        const savedIds = new Map(saved.map((copy) => [copy.copyId, copy.id]));
        for (const result of results) if (savedIds.has(result.copyId)) result.id = savedIds.get(result.copyId);
      }
      return { copies: results, nextSequence: Math.min(Number.MAX_SAFE_INTEGER, Math.max(device.contactSequence, dto.sequence) + 1) };
    });
  }

  async list(query: ListKoreaderCopiesDto, user: RequestUser): Promise<KoreaderInstalledCopyPage> {
    this.requireAccess(user);
    const filters = and(
      eq(copies.userId, user.id),
      query.deviceId ? eq(copies.deviceId, query.deviceId) : undefined,
      query.bookFileId ? eq(copies.bookFileId, query.bookFileId) : undefined,
    );
    if (query.cursor) {
      const [cursor] = await this.db
        .select({ id: copies.id })
        .from(copies)
        .where(and(filters, eq(copies.id, query.cursor)))
        .limit(1);
      if (!cursor) throw new BadRequestException('Copy cursor does not belong to this inventory');
    }
    const rows = await this.db
      .select({ copy: copies, device: devices })
      .from(copies)
      .innerJoin(devices, and(eq(devices.userId, copies.userId), eq(devices.deviceId, copies.deviceId)))
      .where(and(filters, query.cursor ? gt(copies.id, query.cursor) : undefined))
      .orderBy(asc(copies.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const accessible = await this.books.findAccessibleFiles([...new Set(page.map((row) => row.copy.bookFileId))], user);
    const files = new Map(accessible.map((file) => [file.id, file]));
    return {
      items: page.flatMap(({ copy, device }) => {
        const file = files.get(copy.bookFileId);
        if (!file) return [];
        const effectivePolicyVersion = `${device.policyVersion}:${copy.policyVersion}`;
        return [
          {
            id: copy.id,
            copyId: copy.copyId,
            deviceId: copy.deviceId,
            bookId: file.bookId,
            bookFileId: copy.bookFileId,
            pathname: copy.pathname,
            sha256: copy.sha256,
            sizeBytes: copy.sizeBytes,
            revisionId: copy.revisionId,
            currentRevisionId: file.currentRevisionId,
            currentSha256: file.sha256,
            identity: copy.revisionId ? ('known' as const) : ('provisional' as const),
            policy: copy.policy ?? device.policy,
            policyOverride: copy.policy,
            policyVersion: copy.policyVersion,
            effectivePolicyVersion,
            policyAcknowledged: copy.policyAcknowledgement === effectivePolicyVersion,
            lastContactAt: copy.lastContactAt.toISOString(),
            deliveryCapabilityVersion: device.deliveryCapabilityVersion,
            positionCapabilityVersion: device.positionCapabilityVersion,
          },
        ];
      }),
      nextCursor: rows.length > query.limit ? page.at(-1)!.copy.id : null,
    };
  }

  async listDevices(query: ListKoreaderDeliveryDevicesDto, user: RequestUser): Promise<KoreaderDeliveryDevicePage> {
    this.requireAccess(user);
    const rows = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.userId, user.id), query.cursor ? gt(devices.deviceId, query.cursor) : undefined))
      .orderBy(asc(devices.deviceId))
      .limit(query.limit + 1);
    return {
      items: rows.slice(0, query.limit).map((device) => ({
        deviceId: device.deviceId,
        pluginVersion: device.pluginVersion,
        policy: device.policy,
        policyVersion: device.policyVersion,
        deliveryCapabilityVersion: device.deliveryCapabilityVersion,
        positionCapabilityVersion: device.positionCapabilityVersion,
        lastContactAt: device.lastContactAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit ? rows[query.limit - 1].deviceId : null,
    };
  }

  async updateDevicePolicy(deviceId: string, dto: UpdateKoreaderDevicePolicyDto, user: RequestUser) {
    this.requireAccess(user, dto.policy === 'automatic');
    const [updated] = await this.db
      .update(devices)
      .set({ policy: dto.policy, policyVersion: sql`${devices.policyVersion} + 1` })
      .where(and(eq(devices.userId, user.id), eq(devices.deviceId, deviceId), eq(devices.policyVersion, dto.version)))
      .returning();
    if (!updated) throw new ConflictException('Device settings changed or the device is unavailable');
    return { policy: updated.policy, version: updated.policyVersion };
  }

  async updateCopyPolicy(id: string, dto: UpdateKoreaderCopyPolicyDto, user: RequestUser) {
    this.requireAccess(user, dto.policy === 'automatic');
    const [copy] = await this.db
      .select()
      .from(copies)
      .where(and(eq(copies.id, id), eq(copies.userId, user.id)))
      .limit(1);
    if (!copy || !(await this.books.findAccessibleFiles([copy.bookFileId], user)).length) throw new NotFoundException('Installed copy unavailable');
    return this.db.transaction(async (tx) => {
      const [device] = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.userId, user.id), eq(devices.deviceId, copy.deviceId)))
        .for('update');
      if (!device) throw new NotFoundException('Device unavailable');
      if ((dto.policy ?? device.policy) === 'automatic') this.requireAccess(user, true);
      const [updated] = await tx
        .update(copies)
        .set({ policy: dto.policy, policyVersion: sql`${copies.policyVersion} + 1` })
        .where(and(eq(copies.id, id), eq(copies.userId, user.id), eq(copies.policyVersion, dto.version)))
        .returning();
      if (!updated) throw new ConflictException('Copy settings changed; reload before editing');
      return { policy: updated.policy, version: updated.policyVersion, effectivePolicyVersion: `${device.policyVersion}:${updated.policyVersion}` };
    });
  }
}

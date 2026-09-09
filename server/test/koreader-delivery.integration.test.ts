import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_CONTENT_FILTER_RULES, Permission, type KoreaderDeliveryLease } from '@bookorbit/types';
import { DB } from '../src/db';
import * as schema from '../src/db/schema';
import { storageConfig } from '../src/config/config';
import type { RequestUser } from '../src/common/types/request-user';
import { PermissionService } from '../src/common/services/permission.service';
import { BookReadService } from '../src/modules/book/book-read.service';
import { BookRepository } from '../src/modules/book/book.repository';
import { RevisionCatalogService } from '../src/modules/book-revision/revision-catalog.service';
import { RevisionCoordinationService } from '../src/modules/book-revision/revision-coordination.service';
import { RevisionDownloadService } from '../src/modules/book-revision/revision-download.service';
import { KoreaderCopyService } from '../src/modules/koreader/koreader-copy.service';
import { KoreaderRepository } from '../src/modules/koreader/koreader.repository';
import { KoreaderDeliveryService } from '../src/modules/koreader/koreader-delivery.service';
import { KoreaderPluginDeliveryController } from '../src/modules/koreader/koreader-delivery.controller';
import { KoreaderPluginCopiesController } from '../src/modules/koreader/koreader-copy.controller';
import { KoreaderDeliverySchedulerService } from '../src/modules/koreader/koreader-delivery-scheduler.service';
import { KoreaderDeliveryExecutionService } from '../src/modules/koreader/koreader-delivery-execution.service';
import { KoreaderDeliveryAccessService } from '../src/modules/koreader/koreader-delivery-access.service';
import { UserService } from '../src/modules/user/user.service';
import type { KoreaderDeliveryProgressDto } from '../src/modules/koreader/dto/koreader-delivery.dto';

import { runKoreaderHttpFixture } from './helpers/koreader-runtime';
import { KoreaderReadingController } from '../src/modules/koreader/koreader-reading.controller';
import { KoreaderReadingService } from '../src/modules/koreader/koreader-reading.service';
import { CanonicalReadingService } from '../src/modules/book-revision/canonical-reading.service';
import { EpubManifestService } from '../src/modules/book-revision/epub-manifest.service';
import { BookProgressProjectionService } from '../src/modules/book/book-progress-projection.service';
import { ReadingAttemptService } from '../src/modules/user-book-status/reading-attempt.service';
import { ReadingAttemptRepository } from '../src/modules/user-book-status/reading-attempt.repository';

const configPath = process.env.REVISION_TEST_DB_CONFIG;
describe.skipIf(!configPath)('durable KOReader delivery', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let module: TestingModule;
  let deliveries: KoreaderDeliveryService;
  let execution: KoreaderDeliveryExecutionService;
  let inventory: KoreaderCopyService;
  let users: RequestUser[];
  let libraryId: number;
  let file: typeof schema.bookFiles.$inferSelect;
  let revision: typeof schema.bookFileRevisions.$inferSelect;
  let copyId: string;
  let localCopyId: string;
  let root: string;
  const content = Buffer.from('Validated revision content used by the snapshot transport test.');
  const sha256 = createHash('sha256').update(content).digest('hex');
  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (config.database !== 'bookorbit_revision_validation') throw new Error('Isolated validation database required');
    pool = new Pool({ ...config, connectionTimeoutMillis: 10_000, statement_timeout: 20_000 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../src/db/migrations') });
    root = await mkdtemp(join(tmpdir(), 'bookorbit-delivery-'));
    users = (
      await db
        .insert(schema.users)
        .values([0, 1].map(() => ({ username: `delivery-${randomUUID()}`, name: 'Delivery test', passwordHash: 'test-only' })))
        .returning()
    ).map(
      (user) =>
        ({ ...user, permissions: [Permission.KoreaderSync, Permission.LibraryDownload], contentFilters: EMPTY_CONTENT_FILTER_RULES }) as RequestUser,
    );
    await db
      .insert(schema.koreaderUsers)
      .values(users.map((user) => ({ userId: user.id, username: user.username, passwordHash: 'test-only', syncEnabled: true })));
    module = await Test.createTestingModule({
      providers: [
        KoreaderDeliveryService,
        KoreaderDeliverySchedulerService,
        KoreaderDeliveryExecutionService,
        KoreaderDeliveryAccessService,
        KoreaderCopyService,
        KoreaderRepository,
        BookReadService,
        BookRepository,
        RevisionCatalogService,
        RevisionCoordinationService,
        RevisionDownloadService,
        KoreaderReadingService,
        CanonicalReadingService,
        EpubManifestService,
        BookProgressProjectionService,
        ReadingAttemptService,
        ReadingAttemptRepository,
        PermissionService,
        { provide: DB, useValue: db },
        { provide: storageConfig.KEY, useValue: { appDataPath: root } },
        {
          provide: UserService,
          useValue: {
            findByIdWithPermissions: async (id: number) => {
              const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
              return row
                ? { ...row, permissions: users.find((user) => user.id === id)!.permissions, contentFilters: EMPTY_CONTENT_FILTER_RULES }
                : null;
            },
          },
        },
      ],
    }).compile();
    deliveries = module.get(KoreaderDeliveryService);
    execution = module.get(KoreaderDeliveryExecutionService);
    inventory = module.get(KoreaderCopyService);
  }, 60_000);
  beforeEach(async () => {
    users.forEach((user) => {
      user.permissions = [Permission.KoreaderSync, Permission.LibraryDownload];
    });
    await db
      .update(schema.koreaderUsers)
      .set({ syncEnabled: true })
      .where(
        inArray(
          schema.koreaderUsers.userId,
          users.map((user) => user.id),
        ),
      );
    const [library] = await db
      .insert(schema.libraries)
      .values({ name: `delivery-${randomUUID()}` })
      .returning();
    libraryId = library.id;
    const [folder] = await db
      .insert(schema.libraryFolders)
      .values({ libraryId, path: `${root}/${libraryId}` })
      .returning();
    const [book] = await db.insert(schema.books).values({ libraryId, libraryFolderId: folder.id, folderPath: folder.path }).returning();
    const path = join(root, `revision-${libraryId}.epub`);
    await writeFile(path, content);
    [file] = await db
      .insert(schema.bookFiles)
      .values({ bookId: book.id, libraryFolderId: folder.id, absolutePath: path, ino: 1, format: 'epub', sha256, sizeBytes: content.length })
      .returning();
    const [old] = await db
      .insert(schema.bookFileRevisions)
      .values({ bookFileId: file.id, sha256: 'a'.repeat(64), fileHash: '1'.repeat(32), sizeBytes: 100, reason: 'baseline' })
      .returning();
    [revision] = await db
      .insert(schema.bookFileRevisions)
      .values({ bookFileId: file.id, sha256, fileHash: '2'.repeat(32), sizeBytes: content.length, reason: 'fanficfare' })
      .returning();
    await db.update(schema.bookFiles).set({ currentRevisionId: revision.id }).where(eq(schema.bookFiles.id, file.id));
    await db.insert(schema.userLibraryAccess).values(users.map((user) => ({ userId: user.id, libraryId, accessLevel: 'viewer' as const })));
    localCopyId = randomUUID();
    const result = await inventory.report(
      {
        protocolVersion: 1,
        deviceId: 'reader',
        sequence: 1,
        pluginVersion: 'validation',
        deliveryCapabilityVersion: 1,
        positionCapabilityVersion: 1,
        copies: [{ copyId: localCopyId, bookFileId: file.id, pathname: '/books/story.epub', sha256: old.sha256, revisionId: old.id, sizeBytes: 100 }],
      },
      users[0],
    );
    copyId = result.copies[0].id!;
  });
  afterEach(async () => {
    await db.delete(schema.libraries).where(eq(schema.libraries.id, libraryId));
    await db.delete(schema.koreaderDeliveryDevices).where(
      inArray(
        schema.koreaderDeliveryDevices.userId,
        users.map((user) => user.id),
      ),
    );
  });
  afterAll(async () => {
    await module?.close();
    if (users)
      await db.delete(schema.users).where(
        inArray(
          schema.users.id,
          users.map((user) => user.id),
        ),
      );
    await pool?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const request = () => deliveries.request(copyId, { idempotencyKey: randomUUID(), expectedRevisionId: revision.id }, users[0]);
  const identity = (lease: KoreaderDeliveryLease) => ({ deviceId: 'reader', token: lease.token, fence: lease.fence });
  const progress = (lease: KoreaderDeliveryLease, overrides: Partial<KoreaderDeliveryProgressDto> = {}): KoreaderDeliveryProgressDto => ({
    ...identity(lease),
    sequence: 1,
    state: 'downloading',
    localSha256: 'a'.repeat(64),
    localSizeBytes: 100,
    pathname: '/books/story.epub',
    readingUploadsComplete: true,
    ...overrides,
  });
  async function claim() {
    const job = await request();
    return execution.claim(job.id, { deviceId: 'reader', claimId: randomUUID() }, users[0]);
  }
  async function enableAutomatic() {
    await inventory.updateDevicePolicy('reader', { policy: 'automatic', version: 1 }, users[0]);
    return inventory.acknowledgePolicies({ deviceId: 'reader', copies: [{ id: copyId, effectivePolicyVersion: '2:1' }] }, users[0]);
  }
  it('requires current policy acknowledgement before scheduling and preserves cancellation suppression', async () => {
    const scheduler = module.get(KoreaderDeliverySchedulerService);
    expect((await scheduler.runBatch()).checked).toBe(0);
    await inventory.updateDevicePolicy('reader', { policy: 'automatic', version: 1 }, users[0]);
    expect((await scheduler.runBatch()).checked).toBe(0);
    expect(await inventory.acknowledgePolicies({ deviceId: 'reader', copies: [{ id: copyId, effectivePolicyVersion: '1:1' }] }, users[0])).toEqual({
      accepted: [],
    });
    expect(await inventory.acknowledgePolicies({ deviceId: 'reader', copies: [{ id: copyId, effectivePolicyVersion: '2:1' }] }, users[0])).toEqual({
      accepted: [copyId],
    });
    const results = await Promise.all([scheduler.runBatch(), scheduler.runBatch()]);
    expect(results.reduce((sum, result) => sum + result.requested, 0)).toBe(1);
    const [job] = await db.select().from(schema.koreaderDeliveryJobs).where(eq(schema.koreaderDeliveryJobs.installedCopyId, copyId));
    expect(job.mode).toBe('automatic');
    await deliveries.cancel(job.id, job.version, users[0]);
    await db
      .update(schema.koreaderInstalledCopies)
      .set({ deliveryCheckAfter: new Date(0) })
      .where(eq(schema.koreaderInstalledCopies.id, copyId));
    expect((await scheduler.runBatch()).requested).toBe(0);
    const [cancelled] = await db.select().from(schema.koreaderDeliveryJobs).where(eq(schema.koreaderDeliveryJobs.id, job.id));
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.attempt).toBe(1);
  });
  it('keeps policy acknowledgements scoped to the owner, device, library and supported plugin', async () => {
    await enableAutomatic();
    await expect(
      inventory.acknowledgePolicies({ deviceId: 'reader', copies: [{ id: copyId, effectivePolicyVersion: '2:1' }] }, users[1]),
    ).rejects.toThrow('plugin');
    await expect(
      inventory.acknowledgePolicies({ deviceId: 'other-device', copies: [{ id: copyId, effectivePolicyVersion: '2:1' }] }, users[0]),
    ).rejects.toThrow('plugin');
    await db.delete(schema.userLibraryAccess).where(eq(schema.userLibraryAccess.userId, users[0].id));
    expect(await inventory.acknowledgePolicies({ deviceId: 'reader', copies: [{ id: copyId, effectivePolicyVersion: '2:1' }] }, users[0])).toEqual({
      accepted: [],
    });
    expect((await module.get(KoreaderDeliverySchedulerService).runBatch()).requested).toBe(0);
  });
  it('rechecks synchronization and download access while scheduling automatic delivery', async () => {
    await enableAutomatic();
    users[0].permissions = [Permission.KoreaderSync];
    expect((await module.get(KoreaderDeliverySchedulerService).runBatch()).requested).toBe(0);
    users[0].permissions = [Permission.KoreaderSync, Permission.LibraryDownload];
    await db
      .update(schema.koreaderInstalledCopies)
      .set({ deliveryCheckAfter: new Date(0) })
      .where(eq(schema.koreaderInstalledCopies.id, copyId));
    await db.update(schema.koreaderUsers).set({ syncEnabled: false }).where(eq(schema.koreaderUsers.userId, users[0].id));
    expect((await module.get(KoreaderDeliverySchedulerService).runBatch()).requested).toBe(0);
  });
  it('advances bounded scheduling batches beyond unchanged copies', async () => {
    await enableAutomatic();
    const [original] = await db.select().from(schema.koreaderInstalledCopies).where(eq(schema.koreaderInstalledCopies.id, copyId));
    await db.insert(schema.koreaderInstalledCopies).values(
      Array.from({ length: 101 }, (_, index) => {
        const pathname = `/books/unchanged-${index}.epub`;
        return {
          ...original,
          id: randomUUID(),
          copyId: randomUUID(),
          pathname,
          pathnameHash: createHash('sha256').update(pathname).digest('hex'),
          sha256,
          sizeBytes: content.length,
          revisionId: revision.id,
          deliveryCheckAfter: new Date(0),
        };
      }),
    );
    const scheduler = module.get(KoreaderDeliverySchedulerService);
    const first = await scheduler.runBatch();
    const second = await scheduler.runBatch();
    expect(first.checked).toBe(100);
    expect(second.checked).toBe(2);
    expect(first.requested + second.requested).toBe(1);
    expect((await scheduler.runBatch()).checked).toBe(0);
  });
  it('paginates twenty thousand installed copies while scheduling only acknowledged automatic copies', async () => {
    await enableAutomatic();
    const [original] = await db.select().from(schema.koreaderInstalledCopies).where(eq(schema.koreaderInstalledCopies.id, copyId));
    for (let batch = 0; batch < 40; batch++) {
      await db.insert(schema.koreaderInstalledCopies).values(
        Array.from({ length: 500 }, (_, offset) => {
          const index = batch * 500 + offset;
          const pathname = `/books/large-inventory-${index}.epub`;
          return {
            ...original,
            id: randomUUID(),
            copyId: randomUUID(),
            pathname,
            pathnameHash: createHash('sha256').update(pathname).digest('hex'),
            sha256,
            sizeBytes: content.length,
            revisionId: revision.id,
            policy: index < 100 ? null : index % 2 ? ('notify' as const) : ('ignore' as const),
            deliveryCheckAfter: new Date(0),
          };
        }),
      );
    }
    const first = await inventory.list({ deviceId: 'reader', bookFileId: file.id, limit: 50 }, users[0]);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    const second = await inventory.list({ deviceId: 'reader', bookFileId: file.id, limit: 50, cursor: first.nextCursor! }, users[0]);
    expect(second.items).toHaveLength(50);
    expect(new Set([...first.items, ...second.items].map((copy) => copy.id)).size).toBe(100);
    expect(new Set([...first.items, ...second.items].map((copy) => copy.pathname)).size).toBe(100);
    expect((await inventory.list({ limit: 50 }, users[1])).items).toHaveLength(0);
    await expect(inventory.list({ limit: 50, cursor: first.nextCursor! }, users[1])).rejects.toThrow('does not belong');
    const scheduler = module.get(KoreaderDeliverySchedulerService);
    const scheduled = [await scheduler.runBatch(), await scheduler.runBatch()];
    expect(scheduled.map((batch) => batch.checked)).toEqual([100, 1]);
    expect(scheduled.reduce((sum, batch) => sum + batch.requested, 0)).toBe(1);
    expect((await scheduler.runBatch()).checked).toBe(0);
  }, 120_000);

  it('returns revision targets only within current library and download access', async () => {
    expect((await deliveries.targets([file.id], users[0])).items).toEqual([
      { bookFileId: file.id, bookId: file.bookId, revisionId: revision.id, sha256, sizeBytes: content.length },
    ]);
    await db.delete(schema.userLibraryAccess).where(eq(schema.userLibraryAccess.userId, users[1].id));
    expect((await deliveries.targets([file.id], users[1])).items).toEqual([]);
    users[0].permissions = [Permission.KoreaderSync];
    await expect(deliveries.targets([file.id], users[0])).rejects.toThrow('permission');
  });
  it('records first-open failure and verified native evidence without requiring a reading event', async () => {
    const lease = await claim();
    const report = { deviceId: 'reader', copyId: localCopyId, sha256, quality: 'verified' as const, nativePosition: '/body/p[1]' };
    await expect(execution.restoration(lease.job.id, report, users[0])).rejects.toThrow('installed copy');
    await execution.progress(lease.job.id, progress(lease), users[0]);
    const permit = await execution.authorizePublication(lease.job.id, identity(lease), users[0]);
    await execution.progress(
      lease.job.id,
      progress(lease, { sequence: 2, state: 'installed', publicationToken: permit.token, localSha256: sha256, localSizeBytes: content.length }),
      users[0],
    );
    await inventory.report(
      {
        protocolVersion: 1,
        deviceId: 'reader',
        sequence: 2,
        pluginVersion: 'validation',
        deliveryCapabilityVersion: 1,
        positionCapabilityVersion: 1,
        copies: [
          { copyId: localCopyId, bookFileId: file.id, pathname: '/books/story.epub', sha256, revisionId: revision.id, sizeBytes: content.length },
        ],
      },
      users[0],
    );
    await expect(execution.restoration(lease.job.id, { ...report, nativePosition: undefined }, users[0])).rejects.toThrow('native position');
    const failure = { deviceId: 'reader', copyId: localCopyId, sha256, quality: 'failed' as const, failureCode: 'native_verification' as const };
    expect((await execution.restoration(lease.job.id, failure, users[0])).restorationState).toBe('failed');
    const verified = await execution.restoration(lease.job.id, report, users[0]);
    expect(verified.restorationState).toBe('verified');
    expect((await execution.restoration(lease.job.id, failure, users[0])).version).toBe(verified.version);
    const [stored] = await db
      .select({ native: schema.koreaderDeliveryJobs.restorationNativePosition })
      .from(schema.koreaderDeliveryJobs)
      .where(eq(schema.koreaderDeliveryJobs.id, lease.job.id));
    expect(stored.native).toBe('/body/p[1]');
    expect(
      await db
        .select({ id: schema.canonicalReadingEvents.id })
        .from(schema.canonicalReadingEvents)
        .where(eq(schema.canonicalReadingEvents.userId, users[0].id))
        .limit(1),
    ).toEqual([]);
    await expect(execution.restoration(lease.job.id, report, users[1])).rejects.toThrow('unavailable');
  });
  it('reserves one durable request per copy and revision and rejects reused request keys', async () => {
    const dto = { idempotencyKey: randomUUID(), expectedRevisionId: revision.id };
    const results = await Promise.all([deliveries.request(copyId, dto, users[0]), deliveries.request(copyId, dto, users[0]), request()]);
    expect(new Set(results.map((job) => job.id)).size).toBe(1);
    expect(results[0]).toMatchObject({ installationState: 'requested', restorationState: 'verification_pending', mode: 'manual' });
    await expect(deliveries.request(copyId, { ...dto, expectedRevisionId: randomUUID() }, users[0])).rejects.toThrow('identity was reused');
    await expect(deliveries.get(results[0].id, users[1])).rejects.toThrow('unavailable');
  });
  it('persists device failures idempotently and fences failure reports after explicit retry', async () => {
    const lease = await claim();
    await execution.progress(lease.job.id, progress(lease), users[0]);
    const dto = { ...identity(lease), failureCode: 'download_failed' as const };
    const failed = await execution.fail(lease.job.id, dto, users[0]);
    expect(failed.failureCode).toBe('download_failed');
    expect((await execution.fail(lease.job.id, dto, users[0])).version).toBe(failed.version);
    await expect(execution.claim(lease.job.id, { deviceId: 'reader', claimId: randomUUID() }, users[0])).rejects.toThrow('no longer active');
    const retried = await deliveries.retry(lease.job.id, failed.version, users[0]);
    expect(retried.attempt).toBe(2);
    await expect(execution.fail(lease.job.id, dto, users[0])).rejects.toThrow('lease');
    expect((await deliveries.get(lease.job.id, users[0])).failureCode).toBeNull();
  });
  it('separates upload, download, installation and verified restoration without creating reading events', async () => {
    const lease = await claim();
    await expect(execution.authorizePublication(lease.job.id, identity(lease), users[0])).rejects.toThrow('upload prerequisites');
    await expect(execution.progress(lease.job.id, progress(lease, { readingUploadsComplete: false }), users[0])).rejects.toThrow('finish uploading');
    const downloading = await execution.progress(lease.job.id, progress(lease), users[0]);
    expect(downloading.installationState).toBe('downloading');
    expect((await execution.progress(lease.job.id, progress(lease), users[0])).version).toBe(downloading.version);
    const permit = await execution.authorizePublication(lease.job.id, identity(lease), users[0]);
    expect(permit.validForMs).toBeGreaterThan(0);
    expect(permit.validForMs).toBeLessThanOrEqual(30_000);
    await db
      .update(schema.koreaderDeliveryJobs)
      .set({ publicationExpiresAt: new Date(Date.now() + 5_000) })
      .where(eq(schema.koreaderDeliveryJobs.id, lease.job.id));
    const reusedPermit = await execution.authorizePublication(lease.job.id, identity(lease), users[0]);
    expect(reusedPermit.token).toBe(permit.token);
    expect(reusedPermit.validForMs).toBeGreaterThan(0);
    expect(reusedPermit.validForMs).toBeLessThanOrEqual(5_000);
    await expect(
      execution.progress(lease.job.id, progress(lease, { sequence: 2, state: 'installed', publicationToken: permit.token }), users[0]),
    ).rejects.toThrow('authorized revision');
    const installed = await execution.progress(
      lease.job.id,
      progress(lease, { sequence: 2, state: 'installed', publicationToken: permit.token, localSha256: sha256, localSizeBytes: content.length }),
      users[0],
    );
    expect(installed).toMatchObject({ installationState: 'installed', restorationState: 'verification_pending' });
    const acknowledgement = {
      eventId: randomUUID(),
      revision: `sha256:${sha256}`,
      nativeLocator: { kind: 'xpointer' as const, value: '/body/p[3]' },
      quality: 'approximate' as const,
    };
    await execution.acknowledgeRestoration(users[0].id, file.id, 'other-reader', localCopyId, acknowledgement);
    expect((await deliveries.get(installed.id, users[0])).restorationState).toBe('verification_pending');
    await execution.acknowledgeRestoration(users[0].id, file.id, 'reader', localCopyId, acknowledgement);
    expect((await deliveries.get(installed.id, users[0])).restorationState).toBe('approximate');
    expect(await db.select().from(schema.canonicalReadingEvents).where(eq(schema.canonicalReadingEvents.userId, users[0].id))).toEqual([]);
  });
  it.skipIf(process.env.KOREADER_RUNTIME_VALIDATION !== '1').each([
    ['dir', 'managed'],
    ['hash', 'managed'],
    ['dir', 'external'],
    ['hash', 'external'],
  ])(
    'delivers and restores through actual KOReader and authenticated HTTP with %s sidecars and %s replacement',
    async (sidecarMode, replacement) => {
      const revisions = await db.select().from(schema.bookFileRevisions).where(eq(schema.bookFileRevisions.bookFileId, file.id));
      const old = revisions.find((item) => item.reason === 'baseline')!;
      for (const [name, id] of [
        ['original', old.id],
        ['regenerated', revision.id],
      ]) {
        const path = join(import.meta.dirname, '../../client/test/fixtures/revision-continuity', `${name}.epub`);
        const bytes = await readFile(path);
        const manifest = await module.get(EpubManifestService).inspect(path);
        const identity = { sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length };
        await db
          .update(schema.bookFileRevisions)
          .set({
            ...identity,
            chapters: manifest.chapters,
            manifestVersion: manifest.version,
            contentHash: manifest.contentHash,
            metadataHash: manifest.metadataHash,
            coverHash: manifest.coverHash,
          })
          .where(eq(schema.bookFileRevisions.id, id));
        if (name === 'regenerated') {
          await writeFile(file.absolutePath!, bytes);
          await db.update(schema.bookFiles).set(identity).where(eq(schema.bookFiles.id, file.id));
        }
      }
      const key = createHash('md5').update('isolated-native-http-fixture').digest('hex');
      await db.update(schema.koreaderUsers).set({ passwordMd5: key }).where(eq(schema.koreaderUsers.userId, users[0].id));
      const httpModule = await Test.createTestingModule({
        controllers: [KoreaderPluginDeliveryController, KoreaderPluginCopiesController, KoreaderReadingController],
        providers: [
          KoreaderDeliveryService,
          KoreaderDeliveryExecutionService,
          KoreaderCopyService,
          KoreaderReadingService,
          KoreaderRepository,
          UserService,
          PermissionService,
        ].map((provide) => ({ provide, useValue: module.get(provide) })),
      }).compile();
      const app = httpModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      app.setGlobalPrefix('api/v1');
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
      try {
        app
          .getHttpAdapter()
          .getInstance()
          .addHook('onSend', async (req, reply, payload) => {
            if (reply.statusCode >= 400) console.error('Native fixture HTTP failure', req.method, req.url, String(payload));
            return payload;
          });
        await app.listen(0, '127.0.0.1');
        const address = app.getHttpServer().address();
        if (!address || typeof address === 'string') throw new Error('HTTP listener unavailable');
        const output = await runKoreaderHttpFixture(address.port, {
          sidecarMode,
          replacement,
          username: users[0].username,
          key,
          bookId: file.bookId,
          bookFileId: file.id,
          oldRevisionId: old.id,
          revisionId: revision.id,
          copyId,
          localCopyId,
        });
        const line = output.split('\n').find((value) => value.startsWith('REAL_API_RESULT:'));
        expect(line, output).toBeDefined();
        const result = JSON.parse(line!.slice('REAL_API_RESULT:'.length)) as { eventId: string; jobId?: string };
        const events = await db.select().from(schema.canonicalReadingEvents).where(eq(schema.canonicalReadingEvents.bookFileId, file.id));
        expect(events).toHaveLength(1);
        expect(events[0].id).toBe(result.eventId);
        expect(events[0].anchor.revision).toBe(old.id);
        expect(await db.select().from(schema.readingSessions).where(eq(schema.readingSessions.bookFileId, file.id))).toEqual([]);
        const [installed] = await db.select().from(schema.koreaderInstalledCopies).where(eq(schema.koreaderInstalledCopies.id, copyId));
        expect(installed.revisionId).toBe(revision.id);
        if (replacement === 'managed') {
          expect(result.jobId).toBeDefined();
          expect(await deliveries.get(result.jobId!, users[0])).toMatchObject({ installationState: 'installed', restorationState: 'verified' });
        } else {
          expect(result.jobId).toBeUndefined();
          expect(await db.select().from(schema.koreaderDeliveryJobs).where(eq(schema.koreaderDeliveryJobs.installedCopyId, copyId))).toEqual([]);
        }
      } finally {
        await app.close();
      }
    },
    240_000,
  );
  it('authenticates and validates the complete delivery HTTP lifecycle against durable state', async () => {
    const key = createHash('md5').update('isolated-delivery-http-fixture').digest('hex');
    await db.update(schema.koreaderUsers).set({ passwordMd5: key }).where(eq(schema.koreaderUsers.userId, users[0].id));
    const httpModule = await Test.createTestingModule({
      controllers: [KoreaderPluginDeliveryController, KoreaderPluginCopiesController],
      providers: [
        KoreaderDeliveryService,
        KoreaderDeliveryExecutionService,
        KoreaderCopyService,
        KoreaderRepository,
        UserService,
        PermissionService,
      ].map((provide) => ({ provide, useValue: module.get(provide) })),
    }).compile();
    const app = httpModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { 'x-auth-user': users[0].username, 'x-auth-key': key };
    const prefix = '/api/v1/koreader/plugin';
    const post = (route: string, payload: object) => app.inject({ method: 'POST', url: `${prefix}${route}`, headers, payload });
    try {
      expect((await app.inject({ method: 'GET', url: `${prefix}/deliveries` })).statusCode).toBe(401);
      expect(
        (await post(`/deliveries/copies/${copyId}`, { idempotencyKey: randomUUID(), expectedRevisionId: revision.id, userId: users[1].id }))
          .statusCode,
      ).toBe(400);
      const requested = await post(`/deliveries/copies/${copyId}`, { idempotencyKey: randomUUID(), expectedRevisionId: revision.id });
      expect(requested.statusCode, requested.body).toBe(202);
      const jobId = requested.json().id as string;
      const claimed = await post(`/deliveries/${jobId}/claim`, { deviceId: 'reader', claimId: randomUUID() });
      expect(claimed.statusCode, claimed.body).toBe(200);
      const lease = claimed.json<KoreaderDeliveryLease>();
      expect((await post(`/deliveries/${jobId}/publication`, identity(lease))).statusCode).toBe(409);
      const downloading = await post(`/deliveries/${jobId}/progress`, progress(lease));
      expect(downloading.statusCode, downloading.body).toBe(200);
      expect(downloading.json().installationState).toBe('downloading');
      const downloaded = await post(`/deliveries/${jobId}/download`, identity(lease));
      expect(downloaded.statusCode, downloaded.body).toBe(200);
      expect(downloaded.rawPayload).toEqual(content);
      expect(downloaded.headers).toMatchObject({
        'content-type': 'application/epub+zip',
        'content-length': String(content.length),
        'x-bookorbit-revision': revision.id,
        'x-bookorbit-sha256': sha256,
      });
      const permitted = await post(`/deliveries/${jobId}/publication`, identity(lease));
      expect(permitted.statusCode, permitted.body).toBe(200);
      const installed = await post(
        `/deliveries/${jobId}/progress`,
        progress(lease, {
          sequence: 2,
          state: 'installed',
          publicationToken: permitted.json().token,
          localSha256: sha256,
          localSizeBytes: content.length,
        }),
      );
      expect(installed.statusCode, installed.body).toBe(200);
      expect(installed.json()).toMatchObject({ installationState: 'installed', restorationState: 'verification_pending' });
      const reported = await post('/copies', {
        protocolVersion: 1,
        deviceId: 'reader',
        sequence: 2,
        pluginVersion: 'validation',
        deliveryCapabilityVersion: 1,
        positionCapabilityVersion: 1,
        copies: [
          { copyId: localCopyId, bookFileId: file.id, pathname: '/books/story.epub', sha256, revisionId: revision.id, sizeBytes: content.length },
        ],
      });
      expect(reported.statusCode, reported.body).toBe(200);
      const restoration = { deviceId: 'reader', copyId: localCopyId, sha256, quality: 'verified', nativePosition: '/body/p[1]' };
      const verified = await post(`/deliveries/${jobId}/restoration`, restoration);
      expect(verified.statusCode, verified.body).toBe(200);
      expect(verified.json().restorationState).toBe('verified');
      expect((await post(`/deliveries/${jobId}/restoration`, restoration)).json().version).toBe(verified.json().version);
      expect(await db.select().from(schema.canonicalReadingEvents).where(eq(schema.canonicalReadingEvents.userId, users[0].id))).toEqual([]);
      await db.update(schema.koreaderUsers).set({ syncEnabled: false }).where(eq(schema.koreaderUsers.userId, users[0].id));
      expect((await post(`/deliveries/${jobId}/restoration`, restoration)).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('fences expired workers and allows only one concurrent claim', async () => {
    const job = await request();
    const attempts = await Promise.allSettled([0, 1].map(() => execution.claim(job.id, { deviceId: 'reader', claimId: randomUUID() }, users[0])));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = attempts.find((result) => result.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('Expected one claim');
    const first = winner.value;
    await execution.progress(job.id, progress(first), users[0]);
    const permit = await execution.authorizePublication(job.id, identity(first), users[0]);
    await db
      .update(schema.koreaderDeliveryJobs)
      .set({ leaseExpiresAt: new Date(0), publicationExpiresAt: new Date(0) })
      .where(eq(schema.koreaderDeliveryJobs.id, job.id));
    const next = await execution.claim(job.id, { deviceId: 'reader', claimId: randomUUID() }, users[0]);
    expect(next.fence).toBeGreaterThan(first.fence);
    await expect(execution.authorizePublication(job.id, identity(first), users[0])).rejects.toThrow('lease expired');
    await expect(
      execution.progress(
        job.id,
        progress(first, { sequence: 2, state: 'installed', publicationToken: permit.token, localSha256: sha256, localSizeBytes: content.length }),
        users[0],
      ),
    ).rejects.toThrow('lease expired');
    expect((await deliveries.get(job.id, users[0])).installationState).toBe('waiting_for_uploads');
  });
  it('keeps cancellation suppression until explicit retry and records an already authorized installation separately', async () => {
    const lease = await claim();
    await execution.progress(lease.job.id, progress(lease), users[0]);
    const permit = await execution.authorizePublication(lease.job.id, identity(lease), users[0]);
    let job = await deliveries.get(lease.job.id, users[0]);
    job = await deliveries.cancel(job.id, job.version, users[0]);
    expect((await request()).cancelledAt).not.toBeNull();
    await expect(deliveries.retry(job.id, job.version, users[0])).rejects.toThrow('publication permission');
    await expect(execution.authorizePublication(job.id, identity(lease), users[0])).rejects.toThrow('no longer active');
    const installed = await execution.progress(
      job.id,
      progress(lease, { sequence: 2, state: 'installed', publicationToken: permit.token, localSha256: sha256, localSizeBytes: content.length }),
      users[0],
    );
    expect(installed.cancelledAt).not.toBeNull();
    expect(installed.installationState).toBe('installed');
    expect(installed.restorationState).toBe('verification_pending');
  });
  it('clears a cancelled attempt only through explicit retry and rejects old leases afterwards', async () => {
    const lease = await claim();
    const cancelled = await deliveries.cancel(lease.job.id, lease.job.version, users[0]);
    const retried = await deliveries.retry(cancelled.id, cancelled.version, users[0]);
    expect(retried).toMatchObject({ cancelledAt: null, failureCode: null, attempt: 2, installationState: 'requested' });
    await expect(execution.progress(retried.id, progress(lease), users[0])).rejects.toThrow('lease expired');
  });
  it('persists changed revisions and revoked permissions as blocked work', async () => {
    const job = await request();
    users[0].permissions = [Permission.KoreaderSync];
    await expect(execution.claim(job.id, { deviceId: 'reader', claimId: randomUUID() }, users[0])).rejects.toThrow('permission');
    expect((await deliveries.get(job.id, users[0])).failureCode).toBe('access_revoked');
    users[0].permissions = [Permission.KoreaderSync, Permission.LibraryDownload];
    const failed = await deliveries.get(job.id, users[0]);
    await deliveries.retry(job.id, failed.version, users[0]);
    await db.update(schema.bookFiles).set({ currentRevisionId: null }).where(eq(schema.bookFiles.id, file.id));
    await expect(execution.claim(job.id, { deviceId: 'reader', claimId: randomUUID() }, users[0])).rejects.toThrow('server revision changed');
    expect((await deliveries.get(job.id, users[0])).failureCode).toBe('revision_changed');
  });
  it('streams the exact revision and rechecks access when streaming begins', async () => {
    const lease = await claim();
    await execution.progress(lease.job.id, progress(lease), users[0]);
    const result = await execution.download(lease.job.id, identity(lease), users[0], () => false);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(content);
    expect(result.sha256).toBe(sha256);
    const blocked = await execution.download(lease.job.id, identity(lease), users[0], () => false);
    users[0].permissions = [];
    await expect(
      (async () => {
        for await (const chunk of blocked.stream) void chunk;
      })(),
    ).rejects.toThrow('permission');
    const [persisted] = await db
      .select({ failureCode: schema.koreaderDeliveryJobs.failureCode })
      .from(schema.koreaderDeliveryJobs)
      .where(eq(schema.koreaderDeliveryJobs.id, lease.job.id));
    expect(persisted.failureCode).toBe('access_revoked');
  });
  it('requires acknowledged opt-in before automatic delivery and refuses unrecognized installed bytes', async () => {
    const dto = { idempotencyKey: randomUUID(), expectedRevisionId: revision.id };
    await expect(deliveries.request(copyId, dto, users[0], 'automatic')).rejects.toThrow('not acknowledged');
    await inventory.updateDevicePolicy('reader', { version: 1, policy: 'automatic' }, users[0]);
    await expect(deliveries.request(copyId, dto, users[0], 'automatic')).rejects.toThrow('not acknowledged');
    await inventory.report(
      {
        protocolVersion: 1,
        deviceId: 'reader',
        sequence: 2,
        pluginVersion: 'validation',
        deliveryCapabilityVersion: 1,
        positionCapabilityVersion: 1,
        copies: [
          {
            copyId: localCopyId,
            bookFileId: file.id,
            pathname: '/books/story.epub',
            sha256: 'c'.repeat(64),
            sizeBytes: 100,
            policyAcknowledgement: '2:1',
          },
        ],
      },
      users[0],
    );
    await expect(deliveries.request(copyId, dto, users[0], 'automatic')).rejects.toThrow('not acknowledged');
    await inventory.report(
      {
        protocolVersion: 1,
        deviceId: 'reader',
        sequence: 3,
        pluginVersion: 'validation',
        deliveryCapabilityVersion: 1,
        positionCapabilityVersion: 1,
        copies: [
          {
            copyId: localCopyId,
            bookFileId: file.id,
            pathname: '/books/story.epub',
            sha256: 'a'.repeat(64),
            sizeBytes: 100,
            policyAcknowledgement: '2:1',
          },
        ],
      },
      users[0],
    );
    expect((await deliveries.request(copyId, dto, users[0], 'automatic')).mode).toBe('automatic');
  });
  it('paginates large device queues without losing the cursor when a processed job leaves the active list', async () => {
    const reports = Array.from({ length: 100 }, (_, index) => ({
      copyId: randomUUID(),
      bookFileId: file.id,
      pathname: `/batch/story-${index}.epub`,
      sha256: 'a'.repeat(64),
      sizeBytes: 100,
    }));
    const result = await inventory.report(
      {
        protocolVersion: 1,
        deviceId: 'reader',
        sequence: 2,
        pluginVersion: 'validation',
        deliveryCapabilityVersion: 1,
        positionCapabilityVersion: 1,
        copies: reports,
      },
      users[0],
    );
    const entries = result.copies.map((copy, index) => ({
      userId: users[0].id,
      installedCopyId: copy.id!,
      libraryId,
      revisionId: revision.id,
      requestKey: randomUUID(),
      sha256,
      sizeBytes: content.length,
      expectedLocalSha256: 'a'.repeat(64),
      expectedLocalSizeBytes: 100,
      pathname: reports[index].pathname,
      mode: 'manual' as const,
      createdAt: new Date(index < 50 ? '2026-09-01T00:00:00Z' : '2026-09-02T00:00:00Z'),
    }));
    await db.insert(schema.koreaderDeliveryJobs).values(entries);
    const first = await deliveries.list({ limit: 25, deviceId: 'reader', activeOnly: 'true' }, users[0]);
    expect(first.items).toHaveLength(25);
    expect(first.items[0].createdAt).toBe('2026-09-02T00:00:00.000Z');
    await deliveries.cancel(first.items[24].id, first.items[24].version, users[0]);
    const all = [...first.items];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await deliveries.list({ limit: 25, deviceId: 'reader', activeOnly: 'true', cursor }, users[0]);
      expect(page.items.length).toBeLessThanOrEqual(25);
      all.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(new Set(all.map((job) => job.id)).size).toBe(100);
    await expect(deliveries.list({ limit: 25, cursor: first.nextCursor! }, users[1])).rejects.toThrow('cursor unavailable');
  });
});

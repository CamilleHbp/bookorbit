import 'reflect-metadata';
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
import { KoreaderDeliveryExecutionService } from '../src/modules/koreader/koreader-delivery-execution.service';
import { KoreaderDeliveryAccessService } from '../src/modules/koreader/koreader-delivery-access.service';
import { UserService } from '../src/modules/user/user.service';
import type { KoreaderDeliveryProgressDto } from '../src/modules/koreader/dto/koreader-delivery.dto';

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
        KoreaderDeliveryExecutionService,
        KoreaderDeliveryAccessService,
        KoreaderCopyService,
        KoreaderRepository,
        BookReadService,
        BookRepository,
        RevisionCatalogService,
        RevisionCoordinationService,
        RevisionDownloadService,
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
  it('reserves one durable request per copy and revision and rejects reused request keys', async () => {
    const dto = { idempotencyKey: randomUUID(), expectedRevisionId: revision.id };
    const results = await Promise.all([deliveries.request(copyId, dto, users[0]), deliveries.request(copyId, dto, users[0]), request()]);
    expect(new Set(results.map((job) => job.id)).size).toBe(1);
    expect(results[0]).toMatchObject({ installationState: 'requested', restorationState: 'verification_pending', mode: 'manual' });
    await expect(deliveries.request(copyId, { ...dto, expectedRevisionId: randomUUID() }, users[0])).rejects.toThrow('identity was reused');
    await expect(deliveries.get(results[0].id, users[1])).rejects.toThrow('unavailable');
  });
  it('separates upload, download, installation and verified restoration without creating reading events', async () => {
    const lease = await claim();
    await expect(execution.authorizePublication(lease.job.id, identity(lease), users[0])).rejects.toThrow('upload prerequisites');
    await expect(execution.progress(lease.job.id, progress(lease, { readingUploadsComplete: false }), users[0])).rejects.toThrow('finish uploading');
    const downloading = await execution.progress(lease.job.id, progress(lease), users[0]);
    expect(downloading.installationState).toBe('downloading');
    expect((await execution.progress(lease.job.id, progress(lease), users[0])).version).toBe(downloading.version);
    const permit = await execution.authorizePublication(lease.job.id, identity(lease), users[0]);
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

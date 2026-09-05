import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DB } from '../src/db';
import * as schema from '../src/db/schema';
import { fanficfareConfig, storageConfig } from '../src/config/config';
import type { RequestUser } from '../src/common/types/request-user';
import { FanfictionProfileService } from '../src/modules/fanfiction/fanfiction-profile.service';
import { FanfictionAccessService } from '../src/modules/fanfiction/fanfiction-access.service';
import { FanficfareRuntimeService } from '../src/modules/fanfiction/fanficfare-runtime.service';
import { FanfictionVaultService } from '../src/modules/fanfiction/fanfiction-vault.service';
import { FanfictionJobService } from '../src/modules/fanfiction/fanfiction-job.service';
import { FanfictionSourceService } from '../src/modules/fanfiction/fanfiction-source.service';
import { LibraryService } from '../src/modules/library/library.service';
import { AppSettingsService } from '../src/modules/app-settings/app-settings.service';
import { UploadValidatorService } from '../src/modules/upload/upload-validator.service';

const configPath = process.env.REVISION_TEST_DB_CONFIG;
describe.skipIf(!configPath || !process.env.FANFICFARE_TEST_PYTHON)('encrypted Fanfiction profiles with PostgreSQL and pinned runtime', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let service: FanfictionProfileService;
  let jobs: FanfictionJobService;
  let sources: FanfictionSourceService;
  let directory: string;
  let libraryId: number;
  let folderId: number;
  let user: RequestUser;
  const access = { administer: vi.fn(async () => {}) };
  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (config.database !== 'bookorbit_revision_validation') throw new Error('An isolated validation database is required');
    pool = new Pool(config);
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../src/db/migrations') });
    directory = await mkdtemp(join(tmpdir(), 'bookorbit-profile-test-'));
    const module = await Test.createTestingModule({
      providers: [
        FanfictionProfileService,
        FanficfareRuntimeService,
        FanfictionVaultService,
        FanfictionJobService,
        FanfictionSourceService,
        UploadValidatorService,
        { provide: DB, useValue: db },
        { provide: FanfictionAccessService, useValue: access },
        {
          provide: LibraryService,
          useValue: {
            importDestination: async (id: number, requestedFolderId: number) => {
              const [library] = await db.select().from(schema.libraries).where(eq(schema.libraries.id, id)).limit(1);
              const [folder] = await db.select().from(schema.libraryFolders).where(eq(schema.libraryFolders.id, requestedFolderId)).limit(1);
              if (!library || !folder || folder.libraryId !== id) throw new NotFoundException('Import folder not found');
              return { library, folder };
            },
          },
        },
        {
          provide: AppSettingsService,
          useValue: {
            getUploadPattern: () => Promise.resolve(''),
            getUploadPatternBookPerFolder: () => Promise.resolve(''),
            isCrossPlatformPathSanitizationEnabled: () => Promise.resolve(true),
          },
        },
        { provide: storageConfig.KEY, useValue: { appDataPath: directory } },
        { provide: fanficfareConfig.KEY, useValue: { python: resolve(process.env.FANFICFARE_TEST_PYTHON!), timeoutMs: 20_000, maxWorkers: 2 } },
      ],
    }).compile();
    service = module.get(FanfictionProfileService);
    jobs = module.get(FanfictionJobService);
    sources = module.get(FanfictionSourceService);
    const [library] = await db
      .insert(schema.libraries)
      .values({ name: `profile-test-${randomUUID()}` })
      .returning();
    libraryId = library.id;
    const [folder] = await db.insert(schema.libraryFolders).values({ libraryId, path: directory }).returning();
    folderId = folder.id;
    const [account] = await db
      .insert(schema.users)
      .values({ username: `profile-test-${randomUUID()}`, name: 'Profile test', passwordHash: 'not-a-login-hash' })
      .returning();
    user = { ...account, permissions: [], contentFilters: {} } as RequestUser;
  }, 60_000);
  afterEach(async () => {
    await db.delete(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.libraryId, libraryId));
  });
  afterAll(async () => {
    if (libraryId) await db.delete(schema.libraries).where(eq(schema.libraries.id, libraryId));
    if (user) await db.delete(schema.users).where(eq(schema.users.id, user.id));
    await pool?.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('encrypts secrets, preserves advanced configuration, and enforces optimistic updates and library scope', async () => {
    const created = await service.create(
      libraryId,
      {
        name: 'AO3',
        configuration: '[defaults]\ninclude_titlepage: true\n',
        credentials: { section: 'archiveofourown.org', username: 'reader', password: 'private-password' },
      },
      user,
    );
    const [stored] = await db.select().from(schema.fanfictionProfiles).where(eq(schema.fanfictionProfiles.id, created.id));
    expect(JSON.stringify(stored)).not.toContain('private-password');
    const view = await service.get(libraryId, created.id, user);
    expect(view.configuration).toContain('password = ********');
    expect(view.configuration).not.toContain('private-password');
    const updated = await service.update(
      libraryId,
      created.id,
      { name: 'AO3 renamed', version: view.version, configuration: view.configuration, credentials: { section: 'defaults', isAdult: true } },
      user,
    );
    const internal = await service.document(libraryId, created.id, user);
    expect(internal.document.configuration).toContain('password = private-password');
    expect(internal.document.configuration).toContain('include_titlepage = true');
    expect(internal.document.configuration).toContain('is_adult = true');
    await expect(service.update(libraryId, created.id, { name: 'stale', version: view.version }, user)).rejects.toThrow('changed');
    await expect(service.get(libraryId + 1, created.id, user)).rejects.toThrow('not found');
    expect((await service.list(libraryId, { limit: 1 }, user)).items[0]).toEqual(updated);
    access.administer.mockRejectedValueOnce(new ForbiddenException());
    await expect(service.get(libraryId, created.id, user)).rejects.toBeInstanceOf(ForbiddenException);
  }, 30_000);

  it('deduplicates preview requests and enforces global and site concurrency in database claims', async () => {
    const request = { url: 'https://example.org/story/1', idempotencyKey: randomUUID() };
    const first = await jobs.preview(libraryId, request, user);
    expect((await jobs.preview(libraryId, request, user)).id).toBe(first.id);
    await expect(jobs.preview(libraryId, { ...request, url: 'https://example.org/story/2' }, user)).rejects.toThrow('identity');
    await jobs.preview(libraryId, { url: 'https://example.org/story/2', idempotencyKey: randomUUID() }, user);
    await jobs.preview(libraryId, { url: 'https://example.net/story/3', idempotencyKey: randomUUID() }, user);
    const claims = (await Promise.all([jobs.claim(), jobs.claim(), jobs.claim()])).filter((row) => row !== null);
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((row) => row.site)).size).toBe(2);
    expect(await jobs.claim()).toBeNull();
  });

  it('fences expired workers and holds cancellation across claim recovery', async () => {
    const queued = await jobs.preview(libraryId, { url: 'https://example.org/story/1', idempotencyKey: randomUUID() }, user);
    const first = (await jobs.claim())!;
    await db
      .update(schema.fanfictionJobs)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(schema.fanfictionJobs.id, first.id));
    const second = (await jobs.claim())!;
    expect(second.id).toBe(first.id);
    expect(second.fence).toBe(first.fence + 1);
    expect(await jobs.finish(first, 'succeeded')).toBe(false);
    expect(await jobs.renew(first)).toBe(false);
    await expect(db.transaction((tx) => jobs.assertOwnership(first, tx))).rejects.toThrow('ownership expired');
    await expect(db.transaction((tx) => jobs.assertOwnership(second, tx))).resolves.toBeUndefined();
    await jobs.cancel(libraryId, queued.id, user);
    await expect(db.transaction((tx) => jobs.assertOwnership(second, tx))).rejects.toThrow('cancelled');
    expect(await jobs.renew(second)).toBe(false);
    await jobs.finish(second, 'succeeded');
    expect((await jobs.get(libraryId, queued.id, user)).state).toBe('cancelled');
  });

  it('reserves canonical source identity before import and reuses it after a failed attempt', async () => {
    const request = { url: 'https://example.org/story/11', folderId, intervalMinutes: null, idempotencyKey: randomUUID() };
    const queued = await sources.create(libraryId, request, user);
    expect((await sources.create(libraryId, request, user)).id).toBe(queued.id);
    await expect(sources.create(libraryId, { ...request, folderId: folderId + 999 }, user)).rejects.toThrow('folder');
    const first = (await jobs.claim())!;
    const preview = {
      canonicalUrl: 'https://example.org/story/11',
      site: 'example.org',
      title: 'Managed story',
      authors: ['Writer'],
      chapterCount: 10,
      status: 'In-Progress',
      description: '',
      tags: [],
    };
    const reserved = await sources.reserve(first, preview, user);
    expect(reserved.owned).toBe(true);
    expect(reserved.source.bookFileId).toBeNull();
    expect(reserved.source.intervalMinutes).toBeNull();
    await jobs.finish(first, 'failed');
    await sources.create(libraryId, { ...request, idempotencyKey: randomUUID() }, user);
    const second = (await jobs.claim())!;
    const retry = await sources.reserve(second, preview, user);
    expect(retry.source.id).toBe(reserved.source.id);
    expect(retry.source.importOperationId).toBe(reserved.source.importOperationId);
    expect(retry.owned).toBe(true);
    expect((await sources.list(libraryId, { limit: 1 }, user)).items[0]?.id).toBe(reserved.source.id);
    await expect(sources.get(libraryId + 999, reserved.source.id, user)).rejects.toThrow('not found');
  });

  it('keeps the imported book when a source is paused or unlinked and rejects stale edits', async () => {
    const request = { url: 'https://example.org/story/12', folderId, idempotencyKey: randomUUID() };
    await sources.create(libraryId, request, user);
    const job = (await jobs.claim())!;
    const preview = {
      canonicalUrl: request.url,
      site: 'example.org',
      title: 'Unlinked story',
      authors: ['Writer'],
      chapterCount: 12,
      status: 'Completed',
      description: '',
      tags: [],
    };
    const reserved = await sources.reserve(job, preview, user);
    const [book] = await db
      .insert(schema.books)
      .values({ libraryId, libraryFolderId: folderId, folderPath: join(directory, randomUUID()) })
      .returning();
    const [file] = await db
      .insert(schema.bookFiles)
      .values({
        bookId: book.id,
        libraryFolderId: folderId,
        absolutePath: join(directory, `${randomUUID()}.epub`),
        relPath: 'story.epub',
        format: 'epub',
        ino: 1n,
        sizeBytes: 0,
        mtime: new Date(),
      })
      .returning();
    const linked = await sources.completeImport(job, reserved.source.id, { bookId: book.id, bookFileId: file.id });
    expect(linked.state).toBe('active');
    expect(linked.nextCheckAt).toBeInstanceOf(Date);
    await jobs.finish(job, 'succeeded');
    const paused = await sources.update(libraryId, linked.id, { version: linked.version, state: 'paused' }, user);
    expect(paused.nextCheckAt).toBeNull();
    await expect(sources.update(libraryId, linked.id, { version: linked.version, state: 'active' }, user)).rejects.toThrow('changed');
    const unlinked = await sources.update(libraryId, linked.id, { version: paused.version, state: 'unlinked' }, user);
    expect(unlinked.state).toBe('unlinked');
    expect(await db.select({ id: schema.bookFiles.id }).from(schema.bookFiles).where(eq(schema.bookFiles.id, file.id))).toEqual([{ id: file.id }]);
  });
});

import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from '../src/db';
import * as schema from '../src/db/schema';
import type { RequestUser } from '../src/common/types/request-user';
import { FanfictionSourceBatchService } from '../src/modules/fanfiction/fanfiction-source-batch.service';
import { FanfictionSourceService } from '../src/modules/fanfiction/fanfiction-source.service';
import { FanfictionJobService } from '../src/modules/fanfiction/fanfiction-job.service';
import { FanfictionAccessService } from '../src/modules/fanfiction/fanfiction-access.service';
import { FanfictionProfileService } from '../src/modules/fanfiction/fanfiction-profile.service';
import { LibraryService } from '../src/modules/library/library.service';
import { AppSettingsService } from '../src/modules/app-settings/app-settings.service';
import { UploadValidatorService } from '../src/modules/upload/upload-validator.service';
import { ManagedTagService } from '../src/modules/metadata/managed-tag.service';
import { ManagedMetadataService } from '../src/modules/metadata/managed-metadata.service';
import { RevisionCatalogService } from '../src/modules/book-revision/revision-catalog.service';

const configPath = process.env.REVISION_TEST_DB_CONFIG;
describe.skipIf(!configPath)('durable story selections with PostgreSQL', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let batches: FanfictionSourceBatchService;
  let jobs: FanfictionJobService;
  let libraryId: number;
  let folderId: number;
  let user: RequestUser;
  const access = { administer: vi.fn(async () => {}) };
  const authorize = vi.fn(async () => {});
  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (config.database !== 'bookorbit_revision_validation') throw new Error('An isolated validation database is required');
    pool = new Pool(config);
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../src/db/migrations') });
    const module = await Test.createTestingModule({
      providers: [
        FanfictionSourceBatchService,
        FanfictionJobService,
        FanfictionSourceService,
        { provide: DB, useValue: db },
        { provide: FanfictionAccessService, useValue: access },
        ...[
          FanfictionProfileService,
          LibraryService,
          AppSettingsService,
          UploadValidatorService,
          ManagedTagService,
          ManagedMetadataService,
          RevisionCatalogService,
        ].map((provide) => ({ provide, useValue: {} })),
      ],
    }).compile();
    batches = module.get(FanfictionSourceBatchService);
    jobs = module.get(FanfictionJobService);
    const [account] = await db
      .insert(schema.users)
      .values({ username: `source-batch-${randomUUID()}`, name: 'Selection test', passwordHash: 'not-a-login-hash' })
      .returning();
    user = { ...account, permissions: [], contentFilters: {} } as RequestUser;
  }, 60_000);
  beforeEach(async () => {
    vi.clearAllMocks();
    const [library] = await db
      .insert(schema.libraries)
      .values({ name: `source-batch-${randomUUID()}` })
      .returning();
    libraryId = library.id;
    const [folder] = await db
      .insert(schema.libraryFolders)
      .values({ libraryId, path: `/isolated/source-batch/${libraryId}` })
      .returning();
    folderId = folder.id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(schema.libraries).where(eq(schema.libraries.id, libraryId));
  });
  afterAll(async () => {
    if (user) await db.delete(schema.users).where(eq(schema.users.id, user.id));
    await pool?.end();
  });
  async function createSources(count: number, ready = false) {
    const paths = Array.from({ length: count }, () => randomUUID());
    const books = ready
      ? await db
          .insert(schema.books)
          .values(paths.map((path) => ({ libraryId, libraryFolderId: folderId, folderPath: `/isolated/${path}` })))
          .returning()
      : [];
    const files = ready
      ? await db
          .insert(schema.bookFiles)
          .values(
            books.map((book, index) => ({
              bookId: book.id,
              libraryFolderId: folderId,
              absolutePath: `/isolated/${paths[index]}.epub`,
              format: 'epub',
              relPath: `${paths[index]}.epub`,
              sizeBytes: 100,
              ino: index + 1,
            })),
          )
          .returning()
      : [];
    return db
      .insert(schema.fanfictionSources)
      .values(
        paths.map((path, index) => ({
          libraryId,
          createdBy: user.id,
          folderId,
          canonicalUrl: `https://example.org/story/${path}`,
          canonicalKey: createHash('sha256').update(path).digest('hex'),
          site: 'example.org',
          title: `Story ${path}`,
          importOperationId: randomUUID(),
          relativePath: `${path}.epub`,
          ...(ready ? { state: 'active' as const, bookId: books[index].id, bookFileId: files[index].id } : {}),
        })),
      )
      .returning();
  }
  const fresh = async (id: string) => (await db.select().from(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.id, id)))[0];
  const run = (job: typeof schema.fanfictionJobs.$inferSelect, signal = new AbortController().signal) => batches.run(job, user, authorize, signal);

  it('commits child jobs with checkpoints and rolls both back after interruption', async () => {
    const selected = await createSources(2, true);
    const request = { idempotencyKey: randomUUID(), ids: selected.map((source) => source.id), action: 'update' as const };
    const queued = await batches.start(libraryId, request, user);
    expect((await batches.start(libraryId, request, user)).id).toBe(queued.id);
    const job = (await jobs.claim())!;
    expect(job.id).toBe(queued.id);
    const original = jobs.updateStory.bind(jobs);
    const interruption = vi.spyOn(jobs, 'updateStory').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error('Interrupted before the checkpoint');
    });
    await expect(run(job)).rejects.toThrow('Interrupted before the checkpoint');
    expect((await jobs.list(libraryId, { kind: 'update', limit: 100 }, user)).items).toHaveLength(0);
    expect((await fresh(job.id)).sourceSelection?.processed).toBe(0);
    interruption.mockRestore();
    const result = await run(await fresh(job.id));
    expect(result?.selection).toMatchObject({ processed: 2, failed: 0, finished: true });
    expect((await jobs.list(libraryId, { kind: 'update', limit: 100 }, user)).items).toHaveLength(2);
    expect(await jobs.finish(job, 'succeeded', result)).toBe(true);
    expect(await jobs.finish(job, 'succeeded', result)).toBe(false);
    expect(
      await db
        .select()
        .from(schema.fanfictionActivity)
        .where(and(eq(schema.fanfictionActivity.jobId, job.id), eq(schema.fanfictionActivity.kind, 'batch_completed'))),
    ).toHaveLength(1);
  }, 60_000);

  it('resumes cancellation from the last committed item without repeating queued updates', async () => {
    const selected = await createSources(3, true);
    const queued = await batches.start(
      libraryId,
      { idempotencyKey: randomUUID(), ids: selected.map((source) => source.id), action: 'refresh' },
      user,
    );
    const job = (await jobs.claim())!;
    const original = jobs.updateStory.bind(jobs);
    let calls = 0;
    const interrupted = vi.spyOn(jobs, 'updateStory').mockImplementation((...args) => {
      if (++calls === 2) throw new Error('Stopped between items');
      return original(...args);
    });
    await expect(run(job)).rejects.toThrow('Stopped between items');
    expect((await fresh(queued.id)).sourceSelection?.processed).toBe(1);
    await jobs.cancel(libraryId, job.id, user);
    await jobs.finish(job, 'queued');
    expect((await fresh(job.id)).state).toBe('cancelled');
    interrupted.mockRestore();
    await jobs.retry(libraryId, job.id, user);
    let resumed = (await jobs.claim())!;
    if (resumed.id !== job.id) {
      expect(resumed.kind).toBe('refresh');
      await jobs.finish(resumed, 'succeeded');
      resumed = (await jobs.claim())!;
    }
    expect(resumed.id).toBe(job.id);
    expect((await run(resumed))?.selection).toMatchObject({ processed: 3, failed: 0, finished: true, action: 'refresh' });
    expect((await jobs.list(libraryId, { kind: 'refresh', limit: 100 }, user)).items).toHaveLength(3);
  }, 60_000);

  it('retains its cutoff and cursor across bounded batches without including newly created stories', async () => {
    await createSources(101);
    const request = {
      idempotencyKey: randomUUID(),
      allMatching: true,
      state: 'pending' as const,
      action: 'schedule' as const,
      intervalMinutes: null,
    };
    const queued = await batches.start(libraryId, request, user);
    const originalCutoff = (await fresh(queued.id)).sourceSelection!.cutoff;
    let job = (await jobs.claim())!;
    const first = await run(job);
    expect(first?.selection?.processed).toBeGreaterThan(0);
    expect(first?.selection?.processed).toBeLessThanOrEqual(100);
    expect(first?.selection?.finished).toBe(false);
    const added = await createSources(3);
    expect((await batches.start(libraryId, request, user)).id).toBe(queued.id);
    expect((await fresh(queued.id)).sourceSelection!.cutoff).toBe(originalCutoff);
    for (let index = 0; index < 4; index++) {
      job = await fresh(job.id);
      const result = await run(job);
      if (result?.selection?.finished) {
        expect(result.selection.processed).toBe(101);
        await jobs.finish(job, 'succeeded', result);
        break;
      }
    }
    expect((await fresh(job.id)).state).toBe('succeeded');
    for (const source of added)
      expect((await db.select().from(schema.fanfictionSources).where(eq(schema.fanfictionSources.id, source.id)))[0].intervalMinutes).toBe(1440);
  }, 120_000);

  it('retries only failed items and provides a bounded failure review page', async () => {
    const selected = await createSources(2, true);
    await db.update(schema.fanfictionSources).set({ state: 'unlinked' }).where(eq(schema.fanfictionSources.id, selected[1].id));
    const queued = await batches.start(libraryId, { idempotencyKey: randomUUID(), ids: selected.map((source) => source.id), action: 'update' }, user);
    const job = (await jobs.claim())!;
    const result = await run(job);
    expect(result?.selection).toMatchObject({ processed: 2, failed: 1, finished: true });
    await jobs.finish(job, 'review_required', result, 'source_batch_review_required');
    expect((await batches.listFailures(libraryId, queued.id, undefined, 1, user)).items.map((item) => item.sourceId)).toEqual([selected[1].id]);
    await db
      .update(schema.fanfictionJobs)
      .set({ state: 'succeeded' })
      .where(and(eq(schema.fanfictionJobs.libraryId, libraryId), eq(schema.fanfictionJobs.kind, 'update')));
    await db.update(schema.fanfictionSources).set({ state: 'paused', updatedAt: new Date() }).where(eq(schema.fanfictionSources.id, selected[1].id));
    await jobs.retry(libraryId, job.id, user);
    const retry = (await jobs.claim())!;
    expect(retry.id).toBe(job.id);
    expect((await run(retry))?.selection).toMatchObject({ processed: 1, failed: 0, finished: true });
    expect((await batches.listFailures(libraryId, queued.id, undefined, 1, user)).items).toHaveLength(0);
    expect((await jobs.list(libraryId, { kind: 'update', limit: 100 }, user)).items).toHaveLength(2);
  }, 60_000);

  it('keeps work bounded with twenty thousand sources', async () => {
    for (let batch = 0; batch < 40; batch++) await createSources(500);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.fanfictionSources)
      .where(eq(schema.fanfictionSources.libraryId, libraryId));
    expect(count).toBe(20_000);
    await batches.start(libraryId, { idempotencyKey: randomUUID(), allMatching: true, action: 'schedule', intervalMinutes: null }, user);
    const job = (await jobs.claim())!;
    const result = await run(job);
    expect(result?.selection?.processed).toBeGreaterThan(0);
    expect(result?.selection?.processed).toBeLessThanOrEqual(100);
    expect(result?.selection?.finished).toBe(false);
    const [{ changed }] = await db
      .select({ changed: sql<number>`count(*)::int` })
      .from(schema.fanfictionSources)
      .where(and(eq(schema.fanfictionSources.libraryId, libraryId), sql`${schema.fanfictionSources.intervalMinutes} is null`));
    expect(changed).toBe(result?.selection?.processed);
    expect((await fresh(job.id)).sourceSelection?.cursor).toBeTruthy();
  }, 120_000);

  it('rejects actual foreign sources and job review across libraries', async () => {
    const [source] = await createSources(1);
    const [other] = await db
      .insert(schema.libraries)
      .values({ name: `other-batch-${randomUUID()}` })
      .returning();
    try {
      await expect(batches.start(other.id, { idempotencyKey: randomUUID(), ids: [source.id], action: 'update' }, user)).rejects.toThrow(
        'not available in this library',
      );
      const queued = await batches.start(libraryId, { idempotencyKey: randomUUID(), ids: [source.id], action: 'update' }, user);
      await expect(batches.listFailures(other.id, queued.id, undefined, 25, user)).rejects.toThrow();
      for (const input of [
        { ids: [source.id], allMatching: true, action: 'update' as const },
        { action: 'update' as const },
        { ids: [source.id], action: 'schedule' as const },
        { ids: [source.id], action: 'update' as const, intervalMinutes: null },
      ])
        await expect(batches.start(libraryId, { ...input, idempotencyKey: randomUUID() }, user)).rejects.toThrow();
    } finally {
      await db.delete(schema.libraries).where(eq(schema.libraries.id, other.id));
    }
  });

  it('rejects stale leases, cancellation, changed input and cross-library selections', async () => {
    const [source] = await createSources(1);
    const request = { idempotencyKey: randomUUID(), ids: [source.id], action: 'schedule' as const, intervalMinutes: 60 };
    const queued = await batches.start(libraryId, request, user);
    await expect(batches.start(libraryId, { ...request, intervalMinutes: 1440 }, user)).rejects.toThrow('different input');
    await expect(batches.start(libraryId, { ...request, idempotencyKey: randomUUID(), ids: [randomUUID()] }, user)).rejects.toThrow(
      'not available in this library',
    );
    const job = (await jobs.claim())!;
    authorize.mockRejectedValueOnce(new ForbiddenException('Access revoked'));
    await expect(run(job)).rejects.toThrow('Access revoked');
    await expect(run(job, AbortSignal.abort())).rejects.toThrow('cancelled');
    await db
      .update(schema.fanfictionJobs)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(schema.fanfictionJobs.id, queued.id));
    await expect(run(job)).rejects.toThrow();
    expect((await fresh(job.id)).sourceSelection?.processed).toBe(0);
    expect((await db.select().from(schema.fanfictionSources).where(eq(schema.fanfictionSources.id, source.id)))[0].intervalMinutes).toBe(1440);
  });
});

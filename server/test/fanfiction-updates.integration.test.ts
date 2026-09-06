import { RevisionCoordinationService } from '../src/modules/book-revision/revision-coordination.service';
import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipArchive } from 'archiver';
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FanfictionPreview } from '@bookorbit/types';
import { DB } from '../src/db';
import * as schema from '../src/db/schema';
import { storageConfig } from '../src/config/config';
import { FileLockService } from '../src/common/file-lock.service';
import type { RequestUser } from '../src/common/types/request-user';
import { BookRevisionService } from '../src/modules/book-revision/book-revision.service';
import { EpubManifestService } from '../src/modules/book-revision/epub-manifest.service';
import { KoboFileStateService } from '../src/modules/kobo/kobo-file-state.service';
import { RevisionPublicationService } from '../src/modules/book-revision/revision-publication.service';
import { RevisionCatalogService } from '../src/modules/book-revision/revision-catalog.service';
import { RevisionDownloadService } from '../src/modules/book-revision/revision-download.service';
import { FanfictionUpdateService } from '../src/modules/fanfiction/fanfiction-update.service';
import { FanfictionRollbackService } from '../src/modules/fanfiction/fanfiction-rollback.service';
import { FanfictionRecoveryService } from '../src/modules/fanfiction/fanfiction-recovery.service';
import { RevisionInterruptionService } from '../src/modules/book-revision/revision-interruption.service';
import { RevisionRetentionService } from '../src/modules/book-revision/revision-retention.service';
import { FanfictionSourceService } from '../src/modules/fanfiction/fanfiction-source.service';
import { FanfictionJobService } from '../src/modules/fanfiction/fanfiction-job.service';
import { FanfictionAccessService } from '../src/modules/fanfiction/fanfiction-access.service';
import { FanfictionProfileService } from '../src/modules/fanfiction/fanfiction-profile.service';
import { FanficfareRuntimeService } from '../src/modules/fanfiction/fanficfare-runtime.service';
import { LibraryService } from '../src/modules/library/library.service';
import { AppSettingsService } from '../src/modules/app-settings/app-settings.service';
import { UploadValidatorService } from '../src/modules/upload/upload-validator.service';
import { FanfictionActivityService } from '../src/modules/fanfiction/fanfiction-activity.service';
import { recordFanfictionActivity } from '../src/modules/fanfiction/fanfiction-activity';
import { NotificationService } from '../src/modules/notification/notification.service';
import { NotificationRepository } from '../src/modules/notification/notification.repository';
import { NotificationGateway } from '../src/modules/notification/notification.gateway';
import { UserService } from '../src/modules/user/user.service';

const configPath = process.env.REVISION_TEST_DB_CONFIG;
describe.skipIf(!configPath)('managed story updates with durable revisions', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let module: TestingModule;
  let updates: FanfictionUpdateService;
  let sources: FanfictionSourceService;
  let jobs: FanfictionJobService;
  let revisions: BookRevisionService;
  let directory: string;
  let target: string;
  let output: string;
  let libraryId: number;
  let fileId: number;
  let source: typeof schema.fanfictionSources.$inferSelect;
  let user: RequestUser;
  const storage = { appDataPath: '' };
  const document = { configuration: '', cookies: [] };
  const authorize = vi.fn(() => Promise.resolve());
  const preview: FanfictionPreview = {
    canonicalUrl: 'https://example.org/story/1',
    site: 'example.org',
    title: 'Story',
    authors: ['Writer'],
    chapterCount: 2,
    description: '',
    status: 'In-Progress',
    tags: [],
  };
  const runtime = {
    update: vi.fn(
      async <T>(
        _operation: string,
        _url: string,
        _document: unknown,
        prepare: (path: string) => Promise<void>,
        consume: (path: string, preview: FanfictionPreview) => Promise<T>,
      ) => {
        const snapshot = join(directory, `snapshot-${randomUUID()}.epub`);
        await prepare(snapshot);
        expect(await readFile(snapshot)).toEqual(await readFile(target));
        return consume(output, preview);
      },
    ),
  };
  async function epub(path: string, text: string) {
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(path);
      const zip = new ZipArchive({ zlib: { level: 6 } });
      stream.on('close', resolve).on('error', reject);
      zip.on('error', reject);
      zip.pipe(stream);
      zip.append('application/epub+zip', { name: 'mimetype', store: true });
      zip.append('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>', { name: 'META-INF/container.xml' });
      zip.append(
        '<package><metadata><title>Story</title></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>',
        { name: 'book.opf' },
      );
      zip.append(`<html><body><p>${text}</p></body></html>`, { name: 'c.xhtml' });
      void zip.finalize();
    });
  }
  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (config.database !== 'bookorbit_revision_validation') throw new Error('Isolated validation database required');
    pool = new Pool(config);
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../src/db/migrations') });
    const [created] = await db
      .insert(schema.users)
      .values({ username: `update-test-${randomUUID()}`, name: 'Update test', passwordHash: 'not-a-login-hash' })
      .returning();
    user = { ...created, permissions: [], contentFilters: {} } as RequestUser;
    module = await Test.createTestingModule({
      providers: [
        FanfictionUpdateService,
        FanfictionRollbackService,
        FanfictionRecoveryService,
        RevisionInterruptionService,
        RevisionRetentionService,
        FanfictionSourceService,
        FanfictionJobService,
        FanfictionActivityService,
        NotificationService,
        NotificationRepository,
        BookRevisionService,
        RevisionCoordinationService,
        EpubManifestService,
        RevisionPublicationService,
        KoboFileStateService,
        RevisionCatalogService,
        RevisionDownloadService,
        FileLockService,
        { provide: DB, useValue: db },
        { provide: storageConfig.KEY, useValue: storage },
        { provide: FanfictionAccessService, useValue: { administer: () => Promise.resolve() } },
        { provide: FanfictionProfileService, useValue: {} },
        { provide: FanficfareRuntimeService, useValue: runtime },
        { provide: UserService, useValue: { findByIdWithPermissions: () => Promise.resolve(user) } },
        { provide: NotificationGateway, useValue: { emitNew: vi.fn() } },
        { provide: LibraryService, useValue: {} },
        { provide: AppSettingsService, useValue: {} },
        { provide: UploadValidatorService, useValue: {} },
      ],
    }).compile();
    updates = module.get(FanfictionUpdateService);
    sources = module.get(FanfictionSourceService);
    jobs = module.get(FanfictionJobService);
    revisions = module.get(BookRevisionService);
  }, 60_000);
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bookorbit-story-update-'));
    storage.appDataPath = directory;
    target = join(directory, 'story.epub');
    output = join(directory, 'output.epub');
    await epub(target, 'Original passage');
    await epub(output, 'Original passage and an appended chapter');
    const [library] = await db
      .insert(schema.libraries)
      .values({ name: `update-test-${randomUUID()}` })
      .returning();
    libraryId = library.id;
    const [folder] = await db.insert(schema.libraryFolders).values({ libraryId, path: directory }).returning();
    const [book] = await db.insert(schema.books).values({ libraryId, libraryFolderId: folder.id, folderPath: directory }).returning();
    const [file] = await db
      .insert(schema.bookFiles)
      .values({ bookId: book.id, libraryFolderId: folder.id, absolutePath: target, ino: 1, format: 'epub' })
      .returning();
    fileId = file.id;
    await revisions.observeFile(fileId, {});
    [source] = await db
      .insert(schema.fanfictionSources)
      .values({
        libraryId,
        createdBy: user.id,
        folderId: folder.id,
        bookId: book.id,
        bookFileId: fileId,
        canonicalUrl: preview.canonicalUrl,
        canonicalKey: createHash('sha256').update(preview.canonicalUrl).digest('hex'),
        site: preview.site,
        title: preview.title,
        state: 'active',
        chapterCount: 1,
        importOperationId: randomUUID(),
        relativePath: 'story.epub',
        nextCheckAt: sql`now() - interval '1 minute'`,
      })
      .returning();
  }, 30_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    runtime.update.mockClear();
    authorize.mockClear();
    await db.delete(schema.libraries).where(eq(schema.libraries.id, libraryId));
    await db.delete(schema.notifications).where(eq(schema.notifications.userId, user.id));
    await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => {
    await module?.close();
    if (user) await db.delete(schema.users).where(eq(schema.users.id, user.id));
    await pool?.end();
  });
  async function claim(kind: 'update' | 'refresh' = 'update') {
    await sources.check(libraryId, source.id, kind, randomUUID(), user);
    return (await jobs.claim())!;
  }
  const run = (job: NonNullable<Awaited<ReturnType<typeof jobs.claim>>>) => updates.run(job, document, authorize, new AbortController().signal);
  it('updates the existing file, retains rollback bytes, and resumes a lost job completion without fetching twice', async () => {
    const original = await readFile(target);
    const job = await claim();
    const result = await run(job);
    expect(result).toMatchObject({ bookFileId: fileId, sourceId: source.id, noChange: false });
    expect(await readFile(target)).toEqual(await readFile(output));
    const history = await db.select().from(schema.bookFileRevisions).where(eq(schema.bookFileRevisions.bookFileId, fileId));
    expect(history).toHaveLength(2);
    expect(await readFile(history.find((r) => r.storagePath)!.storagePath!)).toEqual(original);
    expect(await jobs.finish(job, 'queued')).toBe(true);
    await db
      .update(schema.fanfictionJobs)
      .set({ runAfter: sql`now()` })
      .where(eq(schema.fanfictionJobs.id, job.id));
    const retry = (await jobs.claim())!;
    expect(await run(retry)).toEqual(result);
    expect(runtime.update).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.fanfictionActivity).where(eq(schema.fanfictionActivity.libraryId, libraryId))).toHaveLength(1);
    expect(await jobs.finish(retry, 'succeeded', result)).toBe(true);
  }, 30_000);
  it('holds source metadata completion until its durable publication can be recovered', async () => {
    const job = await claim('refresh');
    vi.spyOn(sources, 'completeUpdate').mockRejectedValueOnce(new ConflictException('Completion interrupted'));
    await expect(run(job)).rejects.toThrow('Completion interrupted');
    expect(await jobs.finish(job, 'failed', null, 'runtime_failed')).toBe(true);
    expect((await jobs.retry(libraryId, job.id, user)).state).toBe('queued');
    const retry = (await jobs.claim())!;
    const result = await run(retry);
    expect(result?.revisionId).toBeTruthy();
    expect(runtime.update).toHaveBeenCalledTimes(1);
    expect((await sources.get(libraryId, source.id, user)).chapterCount).toBe(2);
    expect(await db.select().from(schema.bookFileRevisions).where(eq(schema.bookFileRevisions.bookFileId, fileId))).toHaveLength(2);
  }, 30_000);
  it('keeps original bytes and revision when regenerated output has no semantic changes', async () => {
    await epub(output, 'Original passage');
    const original = await readFile(target);
    const job = await claim();
    const result = await run(job);
    expect(result?.noChange).toBe(true);
    expect(await readFile(target)).toEqual(original);
    expect(await db.select().from(schema.bookFileRevisions).where(eq(schema.bookFileRevisions.bookFileId, fileId))).toHaveLength(1);
    expect(await jobs.finish(job, 'no_change', result)).toBe(true);
    expect(await db.select().from(schema.fanfictionActivity).where(eq(schema.fanfictionActivity.libraryId, libraryId))).toHaveLength(0);
  }, 60_000);

  it('reconciles cancellation after publication with source metadata and one activity event', async () => {
    const job = await claim();
    vi.spyOn(sources, 'completeUpdate').mockRejectedValueOnce(new ConflictException('Completion interrupted'));
    await expect(run(job)).rejects.toThrow('Completion interrupted');
    await jobs.cancel(libraryId, job.id, user);
    await module.get(FanfictionRecoveryService).recover();
    expect(await sources.get(libraryId, source.id, user)).toMatchObject({ state: 'paused', nextCheckAt: null, chapterCount: 2 });
    expect(await jobs.get(libraryId, job.id, user)).toMatchObject({
      state: 'succeeded',
      cancellationRequested: true,
      result: { bookFileId: fileId },
    });
    expect(await jobs.finish(job, 'failed')).toBe(false);
    await module.get(FanfictionRecoveryService).recover();
    expect(await db.select().from(schema.fanfictionActivity).where(eq(schema.fanfictionActivity.jobId, job.id))).toHaveLength(1);
    expect(runtime.update).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('acknowledges successful journals without changing source settings or duplicating activity', async () => {
    const job = await claim();
    const result = await run(job);
    await jobs.finish(job, 'succeeded', result);
    const before = await sources.get(libraryId, source.id, user);
    await module.get(FanfictionRecoveryService).recover();
    expect(await sources.get(libraryId, source.id, user)).toEqual(before);
    expect(
      (await db.select().from(schema.revisionPublications).where(eq(schema.revisionPublications.ownerKey, job.id)))[0].ownerSettledAt,
    ).not.toBeNull();
    expect(await db.select().from(schema.fanfictionActivity).where(eq(schema.fanfictionActivity.jobId, job.id))).toHaveLength(1);
  }, 60_000);
  it('rejects source changes during a download before file publication', async () => {
    const original = await readFile(target);
    const job = await claim();
    const inspect = module.get(EpubManifestService);
    const originalInspect = inspect.inspect.bind(inspect);
    vi.spyOn(inspect, 'inspect').mockImplementation(async (path) => {
      const manifest = await originalInspect(path);
      if (path === output) await sources.update(libraryId, source.id, { version: source.version, state: 'paused' }, user);
      return manifest;
    });
    await expect(run(job)).rejects.toThrow('settings changed');
    expect(await readFile(target)).toEqual(original);
  }, 30_000);
  it('queues due sources once across concurrent schedulers and respects manual mode', async () => {
    expect((await Promise.all([jobs.enqueueDue(), jobs.enqueueDue()])).reduce((a, b) => a + b)).toBe(1);
    const rows = await db.select().from(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.sourceId, source.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scheduled: true, sourceVersion: source.version, kind: 'update' });
    await db.delete(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.sourceId, source.id));
    await db
      .update(schema.fanfictionSources)
      .set({ intervalMinutes: null, nextCheckAt: sql`now() - interval '1 minute'` })
      .where(eq(schema.fanfictionSources.id, source.id));
    expect(await jobs.enqueueDue()).toBe(0);
  });
  async function activityEvent() {
    await db.transaction((tx) =>
      recordFanfictionActivity(tx, {
        libraryId,
        userId: user.id,
        sourceId: source.id,
        eventKey: `${source.id}:test`,
        kind: 'updated',
        title: 'Updated story',
        bookId: source.bookId,
      }),
    );
  }
  it('commits notifications and outbox acknowledgements atomically and deduplicates concurrent dispatch', async () => {
    await activityEvent();
    const repo = module.get(NotificationRepository);
    const insert = repo.insertInTransaction.bind(repo);
    vi.spyOn(repo, 'insertInTransaction').mockImplementationOnce(async (row, tx) => {
      await insert(row, tx);
      throw new ConflictException('Notification commit interrupted');
    });
    const activity = module.get(FanfictionActivityService);
    await activity.dispatch();
    expect(await db.select().from(schema.notifications).where(eq(schema.notifications.userId, user.id))).toHaveLength(0);
    await db
      .update(schema.fanfictionActivity)
      .set({ notificationRunAfter: sql`now()` })
      .where(eq(schema.fanfictionActivity.libraryId, libraryId));
    const second = new FanfictionActivityService(db, module.get(FanfictionAccessService), module.get(UserService), module.get(NotificationService));
    await Promise.all([activity.dispatch(), second.dispatch()]);
    await activity.dispatch();
    expect(await db.select().from(schema.notifications).where(eq(schema.notifications.userId, user.id))).toHaveLength(1);
    const events = await activity.list(libraryId, { limit: 50 }, user);
    expect(events.items).toHaveLength(1);
    expect(events.nextCursor).toBeNull();
    expect(await activity.list(libraryId + 100000, { limit: 50 }, user)).toEqual({ items: [], nextCursor: null });
    await expect(activity.list(libraryId + 100000, { limit: 50, cursor: events.items[0].id }, user)).rejects.toThrow('not found in this library');
  });
  it('suppresses queued notifications after library access is revoked', async () => {
    await activityEvent();
    vi.spyOn(module.get(FanfictionAccessService), 'administer').mockRejectedValue(new ForbiddenException());
    await module.get(FanfictionActivityService).dispatch();
    expect(await db.select().from(schema.notifications).where(eq(schema.notifications.userId, user.id))).toHaveLength(0);
    const [event] = await db.select().from(schema.fanfictionActivity).where(eq(schema.fanfictionActivity.libraryId, libraryId));
    expect(event.notifiedAt).not.toBeNull();
  });
  it('respects notification preferences while keeping durable activity', async () => {
    await activityEvent();
    await db
      .update(schema.users)
      .set({ settings: { notificationPreferences: { fanfiction: 'off' } } })
      .where(eq(schema.users.id, user.id));
    await module.get(FanfictionActivityService).dispatch();
    expect(await db.select().from(schema.notifications).where(eq(schema.notifications.userId, user.id))).toHaveLength(0);
    expect((await module.get(FanfictionActivityService).list(libraryId, { limit: 50 }, user)).items).toHaveLength(1);
  });
  it('records an actionable failure when the last worker lease expires', async () => {
    const job = await claim();
    await db
      .update(schema.fanfictionJobs)
      .set({ attempts: 3, leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(schema.fanfictionJobs.id, job.id));
    expect(await jobs.claim()).toBeNull();
    const [event] = await db.select().from(schema.fanfictionActivity).where(eq(schema.fanfictionActivity.jobId, job.id));
    expect(event).toMatchObject({ kind: 'failed', errorCode: 'worker_lease_expired', sourceId: source.id });
    expect((await sources.get(libraryId, source.id, user)).attentionCode).toBe('worker_lease_expired');
  });
  it('records failed imports even when authentication fails before a source is reserved', async () => {
    await jobs.importStory(libraryId, { url: 'https://example.org/story/unknown', folderId: source.folderId!, idempotencyKey: randomUUID() }, user);
    const job = (await jobs.claim())!;
    expect(await jobs.finish(job, 'configuration_blocked', null, 'authentication_required')).toBe(true);
    const [event] = await db.select().from(schema.fanfictionActivity).where(eq(schema.fanfictionActivity.jobId, job.id));
    expect(event).toMatchObject({ kind: 'attention', errorCode: 'authentication_required', sourceId: null, libraryId, userId: user.id });
  });
  it('paginates batches with PostgreSQL microsecond timestamps without dropping records', async () => {
    const createdAt = sql`'2026-01-01 00:00:00.123456+00'::timestamptz`;
    await db.update(schema.fanfictionSources).set({ createdAt }).where(eq(schema.fanfictionSources.id, source.id));
    const sourceRows = Array.from({ length: 104 }, (_, i) => ({
      libraryId,
      createdBy: user.id,
      canonicalUrl: `https://example.org/story/batch-${i}`,
      canonicalKey: createHash('sha256').update(`batch-${i}`).digest('hex'),
      site: 'example.org',
      title: `Story ${i}`,
      importOperationId: randomUUID(),
      relativePath: `batch-${i}.epub`,
      createdAt,
    }));
    await db.insert(schema.fanfictionSources).values(sourceRows);
    const jobRows = Array.from({ length: 105 }, () => ({
      libraryId,
      userId: user.id,
      tokenVersion: user.tokenVersion,
      idempotencyKey: randomUUID(),
      kind: 'preview' as const,
      state: 'succeeded' as const,
      url: preview.canonicalUrl,
      site: preview.site,
      createdAt,
    }));
    await db.insert(schema.fanfictionJobs).values(jobRows);
    const activityRows = Array.from({ length: 105 }, () => ({
      libraryId,
      userId: user.id,
      eventKey: randomUUID(),
      kind: 'imported' as const,
      title: 'Imported story',
      createdAt,
    }));
    await db.insert(schema.fanfictionActivity).values(activityRows);
    for (const service of [sources, jobs, module.get(FanfictionActivityService)]) {
      let cursor: string | undefined;
      const ids: string[] = [];
      for (let page = 0; page < 4; page++) {
        const result = await service.list(libraryId, { limit: 50, cursor }, user);
        ids.push(...result.items.map((row) => row.id));
        cursor = result.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(ids).toHaveLength(105);
      expect(new Set(ids).size).toBe(105);
    }
  });
  it('rolls back to retained bytes with a new revision and pauses updates without contacting the runtime', async () => {
    const catalog = module.get(RevisionCatalogService);
    const original = await catalog.current(fileId, libraryId);
    const originalBytes = await readFile(target);
    const updateJob = await claim();
    const update = await run(updateJob);
    await jobs.finish(updateJob, 'succeeded', update);
    const request = { idempotencyKey: randomUUID(), revisionId: original.id, expectedRevisionId: update!.revisionId! };
    const queued = await sources.rollback(libraryId, source.id, request, user);
    expect((await sources.rollback(libraryId, source.id, request, user)).id).toBe(queued.id);
    const rollbackJob = (await jobs.claim())!;
    const rollback = module.get(FanfictionRollbackService);
    vi.spyOn(sources, 'completeRollback').mockRejectedValueOnce(new ConflictException('Rollback completion interrupted'));
    await expect(rollback.run(rollbackJob, authorize, new AbortController().signal)).rejects.toThrow('completion interrupted');
    await jobs.finish(rollbackJob, 'failed', null, 'runtime_failed');
    await jobs.retry(libraryId, rollbackJob.id, user);
    const retry = (await jobs.claim())!;
    const result = await rollback.run(retry, authorize, new AbortController().signal);
    expect(result?.revisionId).not.toBe(original.id);
    expect(result?.revisionId).not.toBe(update?.revisionId);
    expect(await readFile(target)).toEqual(originalBytes);
    expect((await catalog.current(fileId, libraryId)).reason).toBe('rollback');
    expect(await sources.get(libraryId, source.id, user)).toMatchObject({ state: 'paused', nextCheckAt: null });
    expect(runtime.update).toHaveBeenCalledTimes(1);
    const history = await catalog.list(fileId, libraryId);
    expect(history.items).toHaveLength(3);
    expect(history.items.filter((row) => row.canRollback)).toHaveLength(1);
    expect(history.currentRevisionId).toBe(result?.revisionId);
  }, 60_000);
  it('rejects a retained EPUB whose bytes changed after choosing rollback', async () => {
    const catalog = module.get(RevisionCatalogService);
    const original = await catalog.current(fileId, libraryId);
    const updateJob = await claim();
    const update = await run(updateJob);
    await jobs.finish(updateJob, 'succeeded', update);
    const before = await readFile(target);
    await sources.rollback(
      libraryId,
      source.id,
      { idempotencyKey: randomUUID(), revisionId: original.id, expectedRevisionId: update!.revisionId! },
      user,
    );
    const retained = catalog.retained.bind(catalog);
    vi.spyOn(catalog, 'retained').mockImplementationOnce(async (...args) => {
      const selected = await retained(...args);
      await epub(selected.path, 'Unexpected replacement of the retained copy');
      return selected;
    });
    await expect(module.get(FanfictionRollbackService).run((await jobs.claim())!, authorize, new AbortController().signal)).rejects.toThrow(
      'checksum',
    );
    expect(await readFile(target)).toEqual(before);
    expect((await catalog.current(fileId, libraryId)).id).toBe(update?.revisionId);
  }, 60_000);
});

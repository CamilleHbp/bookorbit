import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
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
import { RevisionPublicationService } from '../src/modules/book-revision/revision-publication.service';
import { RevisionCatalogService } from '../src/modules/book-revision/revision-catalog.service';
import { RevisionDownloadService } from '../src/modules/book-revision/revision-download.service';
import { FanfictionUpdateService } from '../src/modules/fanfiction/fanfiction-update.service';
import { FanfictionSourceService } from '../src/modules/fanfiction/fanfiction-source.service';
import { FanfictionJobService } from '../src/modules/fanfiction/fanfiction-job.service';
import { FanfictionAccessService } from '../src/modules/fanfiction/fanfiction-access.service';
import { FanfictionProfileService } from '../src/modules/fanfiction/fanfiction-profile.service';
import { FanficfareRuntimeService } from '../src/modules/fanfiction/fanficfare-runtime.service';
import { LibraryService } from '../src/modules/library/library.service';
import { AppSettingsService } from '../src/modules/app-settings/app-settings.service';
import { UploadValidatorService } from '../src/modules/upload/upload-validator.service';

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
        FanfictionSourceService,
        FanfictionJobService,
        BookRevisionService,
        EpubManifestService,
        RevisionPublicationService,
        RevisionCatalogService,
        RevisionDownloadService,
        FileLockService,
        { provide: DB, useValue: db },
        { provide: storageConfig.KEY, useValue: storage },
        { provide: FanfictionAccessService, useValue: { administer: () => Promise.resolve() } },
        { provide: FanfictionProfileService, useValue: {} },
        { provide: FanficfareRuntimeService, useValue: runtime },
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
  }, 30_000);
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
});

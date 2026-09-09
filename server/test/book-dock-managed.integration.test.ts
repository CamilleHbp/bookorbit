import { RevisionCoordinationService } from '../src/modules/book-revision/revision-coordination.service';
import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DB } from '../src/db';
import * as schema from '../src/db/schema';
import { storageConfig } from '../src/config/config';
import { BookDockManagedService, type ManagedDockImport } from '../src/modules/book-dock/book-dock-managed.service';
import { BookDockRepository } from '../src/modules/book-dock/book-dock.repository';
import { RevisionFileService } from '../src/modules/book-revision/revision-file.service';
import { EpubManifestService } from '../src/modules/book-revision/epub-manifest.service';
import { LibraryService } from '../src/modules/library/library.service';
import { MetadataService } from '../src/modules/metadata/metadata.service';
import { UploadProcessorService } from '../src/modules/upload/upload-processor.service';
import { UploadValidatorService } from '../src/modules/upload/upload-validator.service';
import { BookRevisionService } from '../src/modules/book-revision/book-revision.service';
import { RevisionCatalogService } from '../src/modules/book-revision/revision-catalog.service';
import { FanfictionImportService } from '../src/modules/fanfiction/fanfiction-import.service';
import { ManagedMetadataService } from '../src/modules/metadata/managed-metadata.service';
import { ManagedTagService } from '../src/modules/metadata/managed-tag.service';
import { FanfictionSourceService } from '../src/modules/fanfiction/fanfiction-source.service';
import { FanfictionJobService } from '../src/modules/fanfiction/fanfiction-job.service';
import { FanfictionAccessService } from '../src/modules/fanfiction/fanfiction-access.service';
import { FanfictionProfileService } from '../src/modules/fanfiction/fanfiction-profile.service';
import { FanficfareRuntimeService } from '../src/modules/fanfiction/fanficfare-runtime.service';
import { AppSettingsService } from '../src/modules/app-settings/app-settings.service';
import type { RequestUser } from '../src/common/types/request-user';
import type { FanfictionPreview } from '@bookorbit/types';

const configPath = process.env.REVISION_TEST_DB_CONFIG;
describe.skipIf(!configPath)('durable managed Book Dock imports', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let module: TestingModule;
  let service: BookDockManagedService;
  let files: RevisionFileService;
  let processor: UploadProcessorService;
  let repo: BookDockRepository;
  let directory: string;
  let libraryId: number;
  let folderId: number;
  let userId: number;
  let sourcePath: string;
  let requestUser: RequestUser;
  let imports: FanfictionImportService;
  let sources: FanfictionSourceService;
  let jobs: FanfictionJobService;
  const previewFor = (url: string): FanfictionPreview => ({
    canonicalUrl: url,
    site: 'example.org',
    title: `Story ${url.split('/').at(-1)}`,
    authors: ['Writer'],
    chapterCount: 1,
    status: 'In-Progress',
    description: '',
    tags: [],
  });
  const runtime = {
    preview: vi.fn((url: string) => Promise.resolve(previewFor(url))),
    download: vi.fn(async <T>(url: string, _document: unknown, consume: (path: string, preview: FanfictionPreview) => Promise<T>) =>
      consume(sourcePath, previewFor(url)),
    ),
  };
  const metadata = { extractAndSave: vi.fn(async () => {}) };
  const authorize = vi.fn(async () => {});
  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (config.database !== 'bookorbit_revision_validation') throw new Error('An isolated validation database is required');
    pool = new Pool(config);
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../src/db/migrations') });
    directory = await realpath(await mkdtemp(join(tmpdir(), 'bookorbit-managed-test-')));
    const libraryRoot = join(directory, 'library');
    await mkdir(libraryRoot);
    const [library] = await db
      .insert(schema.libraries)
      .values({ name: `managed-test-${randomUUID()}` })
      .returning();
    libraryId = library.id;
    const [folder] = await db.insert(schema.libraryFolders).values({ libraryId, path: libraryRoot }).returning();
    folderId = folder.id;
    const [user] = await db
      .insert(schema.users)
      .values({ username: `managed-test-${randomUUID()}`, name: 'Managed import test', passwordHash: 'not-a-login-hash' })
      .returning();
    userId = user.id;
    requestUser = { ...user, permissions: [], contentFilters: {} } as RequestUser;
    module = await Test.createTestingModule({
      providers: [
        BookDockManagedService,
        BookDockRepository,
        RevisionFileService,
        EpubManifestService,
        UploadProcessorService,
        UploadValidatorService,
        BookRevisionService,
        RevisionCoordinationService,
        RevisionCatalogService,
        FanfictionImportService,
        FanfictionSourceService,
        ManagedTagService,
        { provide: ManagedMetadataService, useValue: {} },
        FanfictionJobService,
        { provide: FanfictionAccessService, useValue: { administer: async () => {} } },
        { provide: FanfictionProfileService, useValue: { document: () => Promise.resolve({ document: { configuration: '', cookies: [] } }) } },
        { provide: FanficfareRuntimeService, useValue: runtime },
        {
          provide: AppSettingsService,
          useValue: {
            getUploadPattern: () => Promise.resolve(''),
            getUploadPatternBookPerFolder: () => Promise.resolve(''),
            isCrossPlatformPathSanitizationEnabled: () => Promise.resolve(true),
          },
        },
        { provide: DB, useValue: db },
        { provide: storageConfig.KEY, useValue: { appDataPath: directory, bookDockPath: join(directory, 'dock') } },
        { provide: MetadataService, useValue: metadata },
        {
          provide: LibraryService,
          useValue: {
            importDestination: (id: number, requestedFolderId: number) => {
              if (id !== libraryId || requestedFolderId !== folderId) throw new ForbiddenException();
              return Promise.resolve({ library, folder });
            },
          },
        },
      ],
    }).compile();
    service = module.get(BookDockManagedService);
    files = module.get(RevisionFileService);
    processor = module.get(UploadProcessorService);
    repo = module.get(BookDockRepository);
    imports = module.get(FanfictionImportService);
    sources = module.get(FanfictionSourceService);
    jobs = module.get(FanfictionJobService);
    sourcePath = join(directory, 'source.epub');
    const output = createWriteStream(sourcePath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    await new Promise<void>((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      archive.append('application/epub+zip', { name: 'mimetype', store: true });
      archive.append('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>', { name: 'META-INF/container.xml' });
      archive.append(
        '<package><metadata><title>Story</title></metadata><manifest><item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
        { name: 'book.opf' },
      );
      archive.append('<html><body><h1>One</h1><p>A story for a durable import.</p></body></html>', { name: 'one.xhtml' });
      void archive.finalize();
    });
  }, 60_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    metadata.extractAndSave.mockReset();
    authorize.mockReset();
    runtime.preview.mockClear();
    runtime.download.mockClear();
    await db.delete(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.libraryId, libraryId));
  });
  afterAll(async () => {
    await module?.close();
    if (libraryId) await db.delete(schema.libraries).where(eq(schema.libraries.id, libraryId));
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool?.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  function input(): ManagedDockImport {
    const operationId = randomUUID();
    return { operationId, libraryId, folderId, userId, sourcePath, relativePath: `Story-${operationId}/story.epub` };
  }
  async function receipt(request: ManagedDockImport) {
    return (await db.select().from(schema.bookDockManagedImports).where(eq(schema.bookDockManagedImports.id, request.operationId)))[0]!;
  }
  it('finalizes concurrent retries once and keeps a receipt after the dock row is removed', async () => {
    const request = input();
    const [first, second] = await Promise.all([service.ingest(request, authorize), service.ingest(request, authorize)]);
    expect(first).toEqual(second);
    expect(metadata.extractAndSave).toHaveBeenCalledTimes(1);
    expect(await repo.findById(first.dockFileId)).toBeUndefined();
    expect((await receipt(request)).state).toBe('cleanup_complete');
    expect(await service.ingest({ ...request, sourcePath: '/no-longer-present' }, authorize)).toEqual(first);
    expect((await lstat((await receipt(request)).destinationPath)).nlink).toBe(1);
  });
  it('recovers after the filesystem publication succeeds but its transaction rolls back', async () => {
    const request = input();
    const sync = files.sync.bind(files);
    let interrupted = false;
    vi.spyOn(files, 'sync').mockImplementation(async (path) => {
      await sync(path);
      if (path === dirname(join(directory, 'library', request.relativePath)) && !interrupted) {
        const destination = await lstat(join(path, 'story.epub')).catch(() => null);
        if (destination) {
          interrupted = true;
          throw new ConflictException('Simulated publication crash');
        }
      }
    });
    await expect(service.ingest(request, authorize)).rejects.toThrow('Simulated publication crash');
    expect((await receipt(request)).state).toBe('prepared');
    vi.restoreAllMocks();
    const result = await service.ingest(request, authorize);
    expect(result.bookId).toBeGreaterThan(0);
    expect((await receipt(request)).state).toBe('cleanup_complete');
  });
  it('rolls file registration back with the journal and resumes the same publication', async () => {
    const request = input();
    const original = processor.findPlacedFile.bind(processor);
    vi.spyOn(processor, 'findPlacedFile').mockImplementationOnce(async (...args) => {
      expect(await original(...args)).toBeDefined();
      throw new ConflictException('Simulated database crash');
    });
    await expect(service.ingest(request, authorize)).rejects.toThrow('Simulated database crash');
    const record = await receipt(request);
    expect(record.state).toBe('filesystem_published');
    expect(await db.select().from(schema.bookFiles).where(eq(schema.bookFiles.absolutePath, record.destinationPath))).toEqual([]);
    expect((await service.ingest(request, authorize)).bookId).toBeGreaterThan(0);
  });
  it('retains registered book IDs when metadata fails, without presenting a second ordinary import', async () => {
    const request = input();
    metadata.extractAndSave.mockRejectedValueOnce(new ConflictException('Metadata interrupted'));
    await expect(service.ingest(request, authorize)).rejects.toThrow('Metadata interrupted');
    const record = await receipt(request);
    expect(record.state).toBe('database_committed');
    expect(await repo.findByIds([record.dockFileId], userId, false)).toEqual([]);
    const result = await service.ingest(request, authorize);
    expect(result.bookId).toBe(record.bookId);
    expect(result.bookFileId).toBe(record.bookFileId);
  });
  it('retains metadata source ownership across a failed extraction and rejects reassignment', async () => {
    const request = { ...input(), metadataSourceKey: `fanfiction:${randomUUID()}` };
    metadata.extractAndSave.mockRejectedValueOnce(new ConflictException('Metadata interrupted'));
    await expect(service.ingest(request, authorize)).rejects.toThrow('Metadata interrupted');
    expect((await receipt(request)).metadataSourceKey).toBe(request.metadataSourceKey);
    await expect(service.ingest({ ...request, metadataSourceKey: `fanfiction:${randomUUID()}` }, authorize)).rejects.toThrow('source changed');
    const result = await service.ingest(request, authorize);
    expect(metadata.extractAndSave).toHaveBeenLastCalledWith(result.bookId, (await receipt(request)).destinationPath, 'epub', {
      key: request.metadataSourceKey,
      libraryId,
    });
  });

  it('does not replace an unrelated destination even when its SHA-256 is identical', async () => {
    const request = input();
    const destination = join(directory, 'library', request.relativePath);
    await mkdir(dirname(destination));
    await copyFile(sourcePath, destination);
    const original = await lstat(destination);
    await expect(service.ingest(request, authorize)).rejects.toThrow('belongs to another file');
    expect((await lstat(destination)).ino).toBe(original.ino);
    expect((await receipt(request)).state).toBe('prepared');
  });
  it('rechecks authorization immediately before publication and leaves the staged input recoverable', async () => {
    const request = input();
    const copy = files.copy.bind(files);
    vi.spyOn(files, 'copy').mockImplementation(async (source, target) => {
      await copy(source, target);
      if (target.endsWith('initial.epub')) authorize.mockRejectedValue(new ForbiddenException('Access revoked'));
    });
    await expect(service.ingest(request, authorize)).rejects.toThrow('Access revoked');
    expect(await lstat(join(directory, 'library', request.relativePath)).catch(() => null)).toBeNull();
    expect((await receipt(request)).state).toBe('prepared');
  });
  it('rejects symlink parents and changed destinations on a retry', async () => {
    const request = input();
    const outside = join(directory, 'outside');
    await mkdir(outside);
    const target = dirname(join(directory, 'library', request.relativePath));
    await symlink(outside, target);
    await expect(service.ingest(request, authorize)).rejects.toThrow('not a regular directory');
    await expect(service.ingest({ ...request, relativePath: 'other.epub' }, authorize)).rejects.toThrow('destination changed');
  });
  it('does not reimport a book deleted after successful finalization', async () => {
    const request = input();
    const result = await service.ingest(request, authorize);
    await db.delete(schema.books).where(eq(schema.books.id, result.bookId));
    await expect(service.ingest(request, authorize)).rejects.toThrow('was deleted');
  });

  it('connects the durable source job to Book Dock and an initial revision, including a lost completion response', async () => {
    await sources.create(libraryId, { url: 'https://example.org/story/2001', folderId, idempotencyKey: randomUUID() }, requestUser);
    const first = (await jobs.claim())!;
    const result = await imports.run(
      first,
      requestUser,
      { configuration: '', cookies: [] },
      authorize,
      new AbortController().signal,
      undefined,
      (progress) => jobs.reportProgress(first, progress),
    );
    const [tracked] = await db.select().from(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.id, first.id));
    expect(tracked.result?.progress?.stage).toBe('finalizing');
    expect(result?.bookId).toBeGreaterThan(0);
    const revisions = await db.select().from(schema.bookFileRevisions).where(eq(schema.bookFileRevisions.bookFileId, result!.bookFileId!));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.reason).toBe('baseline');
    expect((await sources.get(libraryId, result!.sourceId!, requestUser)).bookId).toBe(result!.bookId);
    await db
      .update(schema.fanfictionJobs)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(schema.fanfictionJobs.id, first.id));
    const retry = (await jobs.claim())!;
    await jobs.reportProgress(first, { stage: 'metadata' });
    const [fenced] = await db.select().from(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.id, first.id));
    expect(fenced.result?.progress?.stage).toBe('finalizing');
    expect(await imports.run(retry, requestUser, { configuration: '', cookies: [] }, authorize, new AbortController().signal)).toEqual(result);
    expect(runtime.preview).toHaveBeenCalledTimes(1);
    expect(runtime.download).toHaveBeenCalledTimes(1);
    expect(await jobs.finish(retry, 'succeeded', result)).toBe(true);
  }, 60_000);

  it('resumes an imported EPUB after metadata failure without contacting the source again', async () => {
    runtime.download.mockImplementationOnce(async (url, _document, consume) =>
      consume(sourcePath, { ...previewFor(url), title: 'Final downloaded title', wordCount: 123456, status: 'Completed' }),
    );
    await sources.create(libraryId, { url: 'https://example.org/story/2002', folderId, idempotencyKey: randomUUID() }, requestUser);
    const first = (await jobs.claim())!;
    metadata.extractAndSave.mockRejectedValueOnce(new ConflictException('Metadata interrupted'));
    await expect(imports.run(first, requestUser, { configuration: '', cookies: [] }, authorize, new AbortController().signal)).rejects.toThrow(
      'Metadata interrupted',
    );
    await db
      .update(schema.fanfictionJobs)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(schema.fanfictionJobs.id, first.id));
    const retry = (await jobs.claim())!;
    const result = await imports.run(retry, requestUser, { configuration: '', cookies: [] }, authorize, new AbortController().signal);
    expect(result?.bookId).toBeGreaterThan(0);
    expect(await sources.get(libraryId, result!.sourceId!, requestUser)).toMatchObject({
      title: 'Final downloaded title',
      wordCount: 123456,
      storyStatus: 'Completed',
    });
    expect(runtime.preview).toHaveBeenCalledTimes(1);
    expect(runtime.download).toHaveBeenCalledTimes(1);
    expect(await jobs.finish(retry, 'succeeded', result)).toBe(true);
  }, 60_000);
});

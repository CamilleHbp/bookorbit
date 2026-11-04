import { TagMatchingService } from '../src/modules/tag-matching/tag-matching.service';
import { CollectionService } from '../src/modules/collection/collection.service';
import { FanfictionReaderService } from '../src/modules/fanfiction/fanfiction-reader.service';
import { FanfictionReviewService } from '../src/modules/fanfiction/fanfiction-review.service';
import { BookMetadataLockService } from '../src/modules/book-metadata-lock/book-metadata-lock.service';
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
import { installPostgresExtensions } from '../src/scripts/postgres-extensions';
import * as schema from '../src/db/schema';
import { storageConfig } from '../src/config/config';
import { BookDockManagedService, type ManagedDockImport } from '../src/modules/book-dock/book-dock-managed.service';
import { BookDockRepository } from '../src/modules/book-dock/book-dock.repository';
import { RevisionFileService } from '../src/modules/book-revision/revision-file.service';
import { EpubManifestService } from '../src/modules/book-revision/epub-manifest.service';
import { LibraryService } from '../src/modules/library/library.service';
import { MetadataService } from '../src/modules/metadata/metadata.service';
import { UploadProcessorService } from '../src/modules/upload/upload-processor.service';
import { BookCoverStore } from '../src/modules/book-cover-store/book-cover-store.service';
import { UploadValidatorService } from '../src/modules/upload/upload-validator.service';
import { BookRevisionService } from '../src/modules/book-revision/book-revision.service';
import { RevisionCatalogService } from '../src/modules/book-revision/revision-catalog.service';
import { FanfictionImportService } from '../src/modules/fanfiction/fanfiction-import.service';
import { ManagedMetadataService } from '../src/modules/metadata/managed-metadata.service';
import { ManagedTagService } from '../src/modules/metadata/managed-tag.service';
import { FanfictionSourceService } from '../src/modules/fanfiction/fanfiction-source.service';
import { FanfictionJobService } from '../src/modules/fanfiction/fanfiction-job.service';
import { FanfictionAccessService } from '../src/modules/fanfiction/fanfiction-access.service';
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
  const metadata = { extractAndSave: vi.fn(async () => {}), replaceAuthors: vi.fn(async () => {}) };
  const authorize = vi.fn(async () => {});
  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (
      config.database !== 'bookorbit_revision_validation' &&
      !/^bookorbit_ux_(fresh|upgrade)_20260910$/.test(config.database ?? '') &&
      !/^bookorbit_metadata_review_[a-z0-9]+$/.test(config.database ?? '') &&
      !/^bookorbit_tagmatch_test_[0-9]+$/.test(config.database ?? '')
    )
      throw new Error('An isolated validation database is required');
    pool = new Pool(config);
    await installPostgresExtensions(pool);
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
        { provide: BookCoverStore, useValue: { removeCoverDirectory: vi.fn().mockResolvedValue(undefined) } },
        UploadValidatorService,
        BookRevisionService,
        RevisionCoordinationService,
        RevisionCatalogService,
        FanfictionImportService,
        FanfictionReviewService,
        FanfictionSourceService,
        { provide: CollectionService, useValue: {} },
        { provide: FanfictionReaderService, useValue: {} },
        ManagedTagService,
        ManagedMetadataService,
        TagMatchingService,
        { provide: BookMetadataLockService, useValue: { filterAutomatedBookUpdate: (_id: number, dto: unknown) => Promise.resolve({ dto }) } },
        FanfictionJobService,
        { provide: FanfictionAccessService, useValue: { administer: async () => {} } },
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
  }, 180_000);
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
  it('restarts obsolete unpublished staging without deleting the original input', async () => {
    const request = input();
    const original = await readFile(sourcePath);
    const copy = files.copy.bind(files);
    vi.spyOn(files, 'copy').mockImplementation(async (source, target) => {
      await copy(source, target);
      if (target.endsWith('initial.epub')) authorize.mockRejectedValue(new ForbiddenException('Pause before publication'));
    });
    await expect(service.ingest(request, authorize)).rejects.toThrow('Pause before publication');
    vi.restoreAllMocks();
    authorize.mockReset();
    expect(await service.resetPrepared(request, authorize)).toEqual({ published: false });
    expect(await service.isPrepared(request, authorize)).toBe(false);
    expect(await readFile(sourcePath)).toEqual(original);
    expect(await lstat((await receipt(request)).destinationPath).catch(() => null)).toBeNull();
    const installed = await service.ingest(request, authorize);
    expect(installed.bookId).toBeGreaterThan(0);
  }, 60000);
  it('retains already published bytes when restarting import matching', async () => {
    const request = input();
    metadata.extractAndSave.mockRejectedValueOnce(new ConflictException('Metadata interrupted'));
    await expect(service.ingest(request, authorize)).rejects.toThrow('Metadata interrupted');
    const stored = await receipt(request);
    const before = await lstat(stored.destinationPath);
    expect(await service.resetPrepared(request, authorize)).toEqual({ published: true });
    expect((await lstat(stored.destinationPath)).ino).toBe(before.ino);
    expect(await readFile(stored.destinationPath)).toEqual(await readFile(sourcePath));
    expect((await receipt(request)).state).toBe('database_committed');
  }, 60000);
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

  async function approveImport() {
    const job = (await jobs.claim())!;
    const before = await db.select({ id: schema.books.id }).from(schema.books).where(eq(schema.books.libraryId, libraryId));
    const result = await imports.run(job, requestUser, { configuration: '', cookies: [] }, authorize, new AbortController().signal);
    expect(result?.importReview?.approved).toBe(false);
    expect(runtime.download).not.toHaveBeenCalled();
    expect(await db.select({ id: schema.books.id }).from(schema.books).where(eq(schema.books.libraryId, libraryId))).toEqual(before);
    await jobs.finish(job, 'review_required', result, 'import_review_required');
    const values = { ...result!.importReview!.values, title: 'Reviewed title', tags: ['Reviewed tag'] };
    await module.get(FanfictionReviewService).importDecision(libraryId, job.id, { action: 'later', values }, requestUser);
    expect((await jobs.get(libraryId, job.id, requestUser)).result?.importReview?.values.title).toBe('Reviewed title');
    await module.get(FanfictionReviewService).importDecision(libraryId, job.id, { action: 'apply', values }, requestUser);
    return (await jobs.claim())!;
  }

  it('imports approved matches with manual additions and exclusions through the full fiction path', async () => {
    const [rulebook] = await db.insert(schema.tagRulebooks).values({ userId }).returning();
    await db.insert(schema.libraryTagRulebooks).values({ libraryId, rulebookId: rulebook.id });
    try {
      const [tag] = await db
        .insert(schema.tags)
        .values({ name: `canonical-${randomUUID()}` })
        .returning();
      const [genre] = await db
        .insert(schema.genres)
        .values({ name: `canonical-genre-${randomUUID()}` })
        .returning();
      const rules = await db
        .insert(schema.tagMatchingRules)
        .values(
          (['tags', 'genres'] as const).map((field) => ({
            rulebookId: rulebook.id,
            source: '',
            field,
            value: 'remote',
            key: 'remote',
            action: 'match' as const,
          })),
        )
        .returning();
      for (const rule of rules)
        await db
          .insert(schema.tagMatchingTargets)
          .values({ ruleId: rule.id, ...(rule.field === 'tags' ? { tagId: tag.id } : { genreId: genre.id }) });
      const url = `https://example.org/story/${randomUUID()}`;
      const incoming: FanfictionPreview = {
        ...previewFor(url),
        labelMappingVersion: 1,
        tags: [tag.name],
        genres: [genre.name],
        rawLabels: [
          { field: 'tags', value: 'remote' },
          { field: 'genres', value: 'remote' },
          { field: 'tags', value: 'unapproved wording' },
        ],
      };
      runtime.preview.mockResolvedValueOnce(incoming);
      runtime.download.mockImplementationOnce(async (_url, _document, consume) => consume(sourcePath, incoming));
      await sources.create(libraryId, { url, folderId, idempotencyKey: randomUUID() }, requestUser);
      const job = (await jobs.claim())!;
      const document = { configuration: '', cookies: [], tagMatching: { version: 1, rules: [] } };
      const proposal = await imports.run(job, requestUser, document, authorize, new AbortController().signal);
      await jobs.finish(job, 'review_required', proposal, 'import_review_required');
      const personalTag = `personal-${randomUUID()}`,
        personalGenre = `personal-genre-${randomUUID()}`;
      await module.get(FanfictionReviewService).importDecision(
        libraryId,
        job.id,
        {
          action: 'apply',
          values: {
            ...proposal!.importReview!.values,
            tags: [tag.name, personalTag],
            genres: [personalGenre],
          },
        },
        requestUser,
      );
      const approved = (await jobs.claim())!;
      const installed = await imports.run(approved, requestUser, document, authorize, new AbortController().signal);
      const tags = await db
        .select({ name: schema.tags.name, manual: schema.bookTags.managedOnly })
        .from(schema.bookTags)
        .innerJoin(schema.tags, eq(schema.tags.id, schema.bookTags.tagId))
        .where(eq(schema.bookTags.bookId, installed!.bookId!));
      expect(tags).toEqual(
        expect.arrayContaining([
          { name: tag.name, manual: true },
          { name: personalTag, manual: false },
        ]),
      );
      expect(tags).toHaveLength(2);
      const genres = await db
        .select({ name: schema.genres.name, managed: schema.bookGenres.managedOnly })
        .from(schema.bookGenres)
        .innerJoin(schema.genres, eq(schema.genres.id, schema.bookGenres.genreId))
        .where(eq(schema.bookGenres.bookId, installed!.bookId!));
      expect(genres).toEqual([{ name: personalGenre, managed: false }]);
      const observations = await db
        .select()
        .from(schema.tagMatchingObservations)
        .where(eq(schema.tagMatchingObservations.bookId, installed!.bookId!));
      expect(observations).toContainEqual(expect.objectContaining({ value: 'unapproved wording', status: 'pending' }));
    } finally {
      await db.delete(schema.libraryTagRulebooks).where(eq(schema.libraryTagRulebooks.libraryId, libraryId));
      await db.delete(schema.tagRulebooks).where(eq(schema.tagRulebooks.id, rulebook.id));
    }
  }, 60000);

  it('preserves approved metadata across a failed download and a retry from a later session', async () => {
    await sources.create(libraryId, { url: 'https://example.org/story/2099', folderId, idempotencyKey: randomUUID() }, requestUser);
    const first = await approveImport();
    runtime.download.mockRejectedValueOnce(new Error('Download interrupted'));
    await expect(imports.run(first, requestUser, { configuration: '', cookies: [] }, authorize, new AbortController().signal)).rejects.toThrow(
      'Download interrupted',
    );
    await jobs.finish(first, 'failed', null, 'import_failed');
    const saved = await jobs.get(libraryId, first.id, { ...requestUser });
    expect(saved.result?.importReview).toEqual(first.result?.importReview);
    expect(saved.result?.importReview?.values.tags).toEqual(['Reviewed tag']);
    await jobs.retry(libraryId, saved.id, { ...requestUser });
    const resumed = (await jobs.claim())!;
    expect(resumed.id).toBe(first.id);
    expect(resumed.result?.importReview).toEqual(first.result?.importReview);
    const previewCalls = runtime.preview.mock.calls.length;
    const result = await imports.run(resumed, requestUser, { configuration: '', cookies: [] }, authorize, new AbortController().signal);
    expect(runtime.preview).toHaveBeenCalledTimes(previewCalls);
    expect(result?.bookId).toBeGreaterThan(0);
    expect((await db.select().from(schema.bookMetadata).where(eq(schema.bookMetadata.bookId, result!.bookId!)))[0].title).toBe('Reviewed title');
    const tags = await db
      .select({ name: schema.tags.name })
      .from(schema.bookTags)
      .innerJoin(schema.tags, eq(schema.tags.id, schema.bookTags.tagId))
      .where(eq(schema.bookTags.bookId, result!.bookId!));
    expect(tags).toEqual([{ name: 'Reviewed tag' }]);
    await jobs.finish(resumed, 'succeeded', result);
  });

  it('pages unfinished imports by owner without history noise or superseded attempts', async () => {
    const [otherUser] = await db
      .insert(schema.users)
      .values({ username: `inbox-${randomUUID()}`, name: 'Other reader', passwordHash: 'not-a-login-hash' })
      .returning();
    try {
      const base = { libraryId, userId, tokenVersion: requestUser.tokenVersion, kind: 'import' as const, site: 'example.org' };
      const [old, latest, failed, queued] = await db
        .insert(schema.fanfictionJobs)
        .values([
          { ...base, idempotencyKey: randomUUID(), url: 'https://example.org/duplicate', state: 'failed', createdAt: new Date('2026-01-01') },
          {
            ...base,
            idempotencyKey: randomUUID(),
            url: 'https://example.org/duplicate',
            state: 'review_required',
            createdAt: new Date('2026-01-02'),
          },
          {
            ...base,
            idempotencyKey: randomUUID(),
            url: 'https://example.org/failed',
            state: 'configuration_blocked',
            createdAt: new Date('2026-01-03'),
          },
          { ...base, idempotencyKey: randomUUID(), url: 'https://example.org/queued', state: 'queued', createdAt: new Date('2026-01-04') },
          { ...base, idempotencyKey: randomUUID(), url: 'https://example.org/completed', state: 'succeeded' },
          { ...base, idempotencyKey: randomUUID(), url: 'https://example.org/cancelled', state: 'cancelled' },
          { ...base, idempotencyKey: randomUUID(), url: 'https://example.org/history', kind: 'preview', state: 'failed' },
          { ...base, idempotencyKey: randomUUID(), userId: otherUser.id, url: 'https://example.org/private', state: 'review_required' },
        ])
        .returning();
      await db
        .insert(schema.fanfictionJobs)
        .values({ ...base, idempotencyKey: randomUUID(), url: latest.url, state: 'succeeded', result: { existingImportId: latest.id } });
      const first = await jobs.list(libraryId, { limit: 2, pendingImportsOnly: 'true' }, requestUser);
      expect(first.items.map((job) => job.id)).toEqual([queued.id, failed.id]);
      const second = await jobs.list(libraryId, { limit: 2, pendingImportsOnly: 'true', cursor: first.nextCursor! }, requestUser);
      expect(second.items.map((job) => job.id)).toEqual([latest.id]);
      expect(second.nextCursor).toBeNull();
      expect([...first.items, ...second.items].some((job) => job.id === old.id)).toBe(false);
      const privileged = await jobs.list(libraryId, { limit: 20, pendingImportsOnly: 'true' }, { ...requestUser, isSuperuser: true });
      expect(privileged.items.map((job) => job.id)).toEqual([queued.id, failed.id, latest.id]);
    } finally {
      await db.delete(schema.users).where(eq(schema.users.id, otherUser.id));
    }
  });

  it('connects the durable source job to Book Dock and an initial revision, including a lost completion response', async () => {
    await sources.create(libraryId, { url: 'https://example.org/story/2001', folderId, idempotencyKey: randomUUID() }, requestUser);
    const first = await approveImport();
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
    expect((await db.select().from(schema.bookMetadata).where(eq(schema.bookMetadata.bookId, result!.bookId!)))[0].title).toBe('Reviewed title');
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
  }, 180_000);

  it('resumes an imported EPUB after metadata failure without contacting the source again', async () => {
    runtime.download.mockImplementationOnce(async (url, _document, consume) =>
      consume(sourcePath, { ...previewFor(url), title: 'Final downloaded title', wordCount: 123456, status: 'Completed' }),
    );
    await sources.create(libraryId, { url: 'https://example.org/story/2002', folderId, idempotencyKey: randomUUID() }, requestUser);
    const first = await approveImport();
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
    expect((await db.select().from(schema.bookMetadata).where(eq(schema.bookMetadata.bookId, result!.bookId!)))[0].title).toBe('Reviewed title');
    expect(await sources.get(libraryId, result!.sourceId!, requestUser)).toMatchObject({
      title: 'Final downloaded title',
      wordCount: 123456,
      storyStatus: 'Completed',
    });
    expect(runtime.preview).toHaveBeenCalledTimes(1);
    expect(runtime.download).toHaveBeenCalledTimes(1);
    expect(await jobs.finish(retry, 'succeeded', result)).toBe(true);
  }, 180_000);
});

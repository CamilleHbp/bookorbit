import { AnnotationConversionService } from '../src/modules/annotation/annotation-conversion.service';
import { AnnotationSyncService } from '../src/modules/annotation/annotation-sync.service';
import { PositionConverterService } from '../src/modules/position-converter/position-converter.service';
import { RevisionCoordinationService } from '../src/modules/book-revision/revision-coordination.service';
import { AnnotationPositionRepository } from '../src/modules/annotation/annotation-position.repository';
import { AnnotationRepository } from '../src/modules/annotation/annotation.repository';
import { AnnotationSyncRepository } from '../src/modules/annotation/annotation-sync.repository';
import { storageConfig } from '../src/config/config';
import { BookRevisionService } from '../src/modules/book-revision/book-revision.service';
import { RevisionMetadataService } from '../src/modules/book-revision/revision-metadata.service';
import { RevisionFileService } from '../src/modules/book-revision/revision-file.service';
import { EpubFormatWriter } from '../src/modules/file-write/formats/epub/epub-format-writer';
import { createBookWriteFieldMask } from '../src/modules/file-write/file-write.constants';
import { RevisionDownloadService } from '../src/modules/book-revision/revision-download.service';
import { Test } from '@nestjs/testing';
import { ZipArchive } from 'archiver';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DB } from '../src/db';
import { FileLockService } from '../src/common/file-lock.service';
import * as schema from '../src/db/schema';
import { EpubManifestService } from '../src/modules/book-revision/epub-manifest.service';
import { RevisionCatalogService } from '../src/modules/book-revision/revision-catalog.service';
import { KoboFileStateService } from '../src/modules/kobo/kobo-file-state.service';
import { RevisionPublicationService } from '../src/modules/book-revision/revision-publication.service';
import { requireInspectedFile } from '../src/modules/book-revision/revision-publication.files';
import { FanfictionJobService } from '../src/modules/fanfiction/fanfiction-job.service';
import { FanfictionAccessService } from '../src/modules/fanfiction/fanfiction-access.service';
import { FanfictionProfileService } from '../src/modules/fanfiction/fanfiction-profile.service';
import type { RevisionPublicationAuthority } from '../src/modules/book-revision/revision-publication-authority';
import { RevisionInterruptionService } from '../src/modules/book-revision/revision-interruption.service';
import { FanfictionRecoveryService } from '../src/modules/fanfiction/fanfiction-recovery.service';
import { RevisionRetentionService } from '../src/modules/book-revision/revision-retention.service';

const configPath = process.env.REVISION_TEST_DB_CONFIG;

describe.skipIf(!configPath)('revision publication with PostgreSQL and real files', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let service: RevisionPublicationService;
  let metadata: RevisionMetadataService;
  let locks: FileLockService;
  let writer: EpubFormatWriter;
  let koboFiles: KoboFileStateService;
  let manifests: EpubManifestService;
  let catalog: RevisionCatalogService;
  let downloads: RevisionDownloadService;
  const storage = { appDataPath: '' };
  let dir: string;
  let libraryId: number;
  let fileId: number;
  let originalId: string;
  let target: string;
  let input: string;
  let originalSha: string;
  let jobs: FanfictionJobService;
  let ownerUserId: number;
  let interruptions: RevisionInterruptionService;
  let recovery: FanfictionRecoveryService;

  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (config.database !== 'bookorbit_revision_validation') throw new Error('An isolated revision validation database is required');
    pool = new Pool(config);
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../src/db/migrations') });
    const module = await Test.createTestingModule({
      providers: [
        RevisionPublicationService,
        BookRevisionService,
        RevisionCoordinationService,
        RevisionMetadataService,
        RevisionFileService,
        EpubFormatWriter,
        KoboFileStateService,
        RevisionRetentionService,
        EpubManifestService,
        RevisionCatalogService,
        RevisionDownloadService,
        FileLockService,
        FanfictionJobService,
        RevisionInterruptionService,
        FanfictionRecoveryService,
        { provide: FanfictionAccessService, useValue: {} },
        { provide: FanfictionProfileService, useValue: {} },
        { provide: DB, useValue: db },
        { provide: storageConfig.KEY, useValue: storage },
      ],
    }).compile();
    service = module.get(RevisionPublicationService);
    metadata = module.get(RevisionMetadataService);
    locks = module.get(FileLockService);
    writer = module.get(EpubFormatWriter);
    koboFiles = module.get(KoboFileStateService);
    manifests = module.get(EpubManifestService);
    catalog = module.get(RevisionCatalogService);
    downloads = module.get(RevisionDownloadService);
    jobs = module.get(FanfictionJobService);
    interruptions = module.get(RevisionInterruptionService);
    recovery = module.get(FanfictionRecoveryService);
    const [user] = await db
      .insert(schema.users)
      .values({ username: `publication-owner-${randomUUID()}`, name: 'Publication owner test', passwordHash: 'not-a-login-hash' })
      .returning();
    ownerUserId = user.id;
  }, 60_000);

  afterAll(async () => {
    if (ownerUserId) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    await pool?.end();
  });

  async function epub(path: string, text: string) {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(path);
      const archive = new ZipArchive({ zlib: { level: 6 } });
      out.on('close', resolve).on('error', reject);
      archive.on('error', reject);
      archive.pipe(out);
      archive.append('application/epub+zip', { name: 'mimetype', store: true });
      archive.append('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>', { name: 'META-INF/container.xml' });
      archive.append(
        '<package version="3.0" xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Story</dc:title></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>',
        { name: 'book.opf' },
      );
      archive.append(`<html><body><p>${text}</p></body></html>`, { name: 'c.xhtml' });
      void archive.finalize();
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bookorbit-publication-'));
    storage.appDataPath = join(dir, 'state');
    target = join(dir, 'books', 'story.epub');
    await mkdir(dirname(target));
    input = join(dir, 'incoming.epub');
    await epub(target, 'Original passage');
    await epub(input, 'Original passage and a new chapter');
    const [library] = await db
      .insert(schema.libraries)
      .values({ name: `revision-test-${randomUUID()}` })
      .returning();
    libraryId = library.id;
    const [folder] = await db.insert(schema.libraryFolders).values({ libraryId, path: dir }).returning();
    const [book] = await db
      .insert(schema.books)
      .values({ libraryId, libraryFolderId: folder.id, folderPath: dirname(target) })
      .returning();
    const inspected = await requireInspectedFile(target);
    originalSha = inspected.sha256;
    const [file] = await db
      .insert(schema.bookFiles)
      .values({
        bookId: book.id,
        libraryFolderId: folder.id,
        absolutePath: target,
        ino: inspected.ino,
        format: 'epub',
        sha256: originalSha,
        fileHash: inspected.fileHash,
      })
      .returning();
    fileId = file.id;
    originalId = randomUUID();
    const manifest = await manifests.inspect(target);
    await db.insert(schema.bookFileRevisions).values({
      id: originalId,
      bookFileId: fileId,
      sha256: originalSha,
      fileHash: inspected.fileHash,
      sizeBytes: inspected.sizeBytes,
      reason: 'baseline',
      changeKind: 'baseline',
      chapters: manifest.chapters,
      contentHash: manifest.contentHash,
      metadataHash: manifest.metadataHash,
      coverHash: manifest.coverHash,
    });
    await db.update(schema.bookFiles).set({ currentRevisionId: originalId }).where(eq(schema.bookFiles.id, fileId));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (libraryId) await db.delete(schema.libraries).where(eq(schema.libraries.id, libraryId));
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function journal(id: string) {
    const [row] = await db.select().from(schema.revisionPublications).where(eq(schema.revisionPublications.id, id));
    return row;
  }

  it('bounds annotation conversion batches after filtering completed and unusable positions', async () => {
    const [file] = await db.select().from(schema.bookFiles).where(eq(schema.bookFiles.id, fileId));
    const module = await Test.createTestingModule({
      providers: [AnnotationPositionRepository, { provide: DB, useValue: db }],
    }).compile();
    const repository = module.get(AnnotationPositionRepository);
    const notes = await db
      .insert(schema.annotations)
      .values(
        Array.from({ length: 140 }, (_, index) => ({
          userId: ownerUserId,
          bookId: file.bookId,
          text: `Passage ${index}`,
          deletedAt: index === 37 ? new Date() : null,
        })),
      )
      .returning({ id: schema.annotations.id });
    await db.insert(schema.annotationPositions).values(
      notes.map((note, index) => ({
        annotationId: note.id,
        userId: ownerUserId,
        bookFileId: index === 36 ? null : fileId,
        format: 'xpointer' as const,
        pos0: index === 35 ? null : `/passage/${index}`,
        status: index === 34 ? ('failed' as const) : index === 35 ? ('pending' as const) : ('exact' as const),
      })),
    );
    await db.insert(schema.annotationPositions).values(
      notes.slice(0, 34).map((note, index) => ({
        annotationId: note.id,
        userId: ownerUserId,
        bookFileId: fileId,
        format: 'cfi' as const,
        pos0: `/converted/${index}`,
        status: index === 33 ? ('pending' as const) : index === 31 || index === 32 ? ('failed' as const) : ('exact' as const),
        converterVersion: index === 30 ? null : index === 32 ? 1 : 2,
        extras: { revisionId: originalId, sha256: originalSha },
      })),
    );
    const first = await repository.findCfiConversionCandidates(ownerUserId, file.bookId, 2, 3);
    expect(first.map((row) => row.annotationId)).toEqual([notes[32].id, notes[33].id, notes[38].id]);
    expect(await repository.findCfiConversionCandidates(ownerUserId + 1, file.bookId, 2, 3)).toEqual([]);
    expect(await repository.findCfiConversionCandidates(ownerUserId, file.bookId + 1, 2, 3)).toEqual([]);
    expect(await repository.findCfiConversionCandidates(ownerUserId, file.bookId, 2, 0)).toEqual([]);
    expect(await repository.findCfiConversionCandidates(ownerUserId, file.bookId, 2, 1000)).toHaveLength(100);
    for (const candidate of first)
      await repository.upsert({
        annotationId: candidate.annotationId,
        userId: ownerUserId,
        bookFileId: fileId,
        format: 'cfi',
        pos0: '/converted',
        status: 'exact',
        converterVersion: 2,
        extras: { revisionId: originalId, sha256: originalSha },
      });
    const second = await repository.findCfiConversionCandidates(ownerUserId, file.bookId, 2, 3);
    expect(second.map((row) => row.annotationId)).toEqual(notes.slice(39, 42).map((note) => note.id));
    await module.close();
  });

  it('invalidates generated annotation positions and failed conversions after publication and rollback', async () => {
    const [file] = await db.select().from(schema.bookFiles).where(eq(schema.bookFiles.id, fileId));
    const converter = { version: 2, xpointerToCfi: vi.fn().mockResolvedValue({ status: 'failed', reason: 'passage_unavailable' }) };
    const sync = await Test.createTestingModule({ providers: [AnnotationSyncRepository, { provide: DB, useValue: db }] }).compile();
    const syncRepository = sync.get(AnnotationSyncRepository);
    const module = await Test.createTestingModule({
      providers: [
        AnnotationRepository,
        AnnotationPositionRepository,
        AnnotationConversionService,
        { provide: DB, useValue: db },
        { provide: PositionConverterService, useValue: converter },
        {
          provide: AnnotationSyncService,
          useValue: {
            upsertGeneratedPosition: (position: typeof schema.annotationPositions.$inferInsert) => syncRepository.upsertPosition(position),
          },
        },
      ],
    }).compile();
    const repository = module.get(AnnotationRepository);
    const positions = module.get(AnnotationPositionRepository);
    const conversions = module.get(AnnotationConversionService);
    const [note] = await db.insert(schema.annotations).values({ userId: ownerUserId, bookId: file.bookId, text: 'Original passage' }).returning();
    expect(await syncRepository.findPositionFileIdentity(ownerUserId, file.bookId, fileId)).toEqual({
      revisionId: file.currentRevisionId,
      sha256: file.sha256,
    });
    expect(await syncRepository.findPositionFileIdentity(-1, file.bookId, fileId)).toBeNull();
    expect(await syncRepository.findPositionFileIdentity(ownerUserId, -1, fileId)).toBeNull();
    await positions.upsert({
      annotationId: note.id,
      userId: ownerUserId,
      bookFileId: fileId,
      format: 'xpointer',
      pos0: '/original',
      status: 'exact',
    });
    expect(await conversions.ensureCfiPositionsForBook(ownerUserId, file.bookId)).toBe(0);
    expect((await repository.findById(file.bookId, note.id, ownerUserId))?.cfiStatus).toBe('failed');
    expect(await positions.findCfiConversionCandidates(ownerUserId, file.bookId, 2, 25)).toEqual([]);
    const prepared = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare');
    const installed = await service.resume(prepared.publicationId, libraryId);
    expect(await syncRepository.findPositionFileIdentity(ownerUserId, file.bookId, fileId)).toMatchObject({ revisionId: installed.revisionId });
    expect(await repository.findById(file.bookId, note.id, ownerUserId)).toMatchObject({ cfi: null, cfiStatus: 'pending' });
    converter.xpointerToCfi.mockResolvedValue({ status: 'exact', cfi: 'epubcfi(/6/2!/4/2/1:0)' });
    expect(await conversions.ensureCfiPositionsForBook(ownerUserId, file.bookId)).toBe(1);
    expect(await repository.findById(file.bookId, note.id, ownerUserId)).toMatchObject({
      cfi: 'epubcfi(/6/2!/4/2/1:0)',
      cfiStatus: 'exact',
      cfiExtras: { revisionId: installed.revisionId },
      version: note.version,
    });
    const retained = await catalog.retained(fileId, libraryId, originalId, installed.revisionId);
    const rollback = await service.prepare(fileId, libraryId, installed.revisionId, retained.path, 'rollback', undefined, retained.sha256);
    await service.resume(rollback.publicationId, libraryId);
    expect(await repository.findById(file.bookId, note.id, ownerUserId)).toMatchObject({ cfi: null, cfiStatus: 'pending', version: note.version });
    expect(await positions.findCfiConversionCandidates(ownerUserId, file.bookId, 2, 25)).toHaveLength(1);
    expect(await repository.findHubById(ownerUserId, note.id)).toMatchObject({ cfi: null, cfiStatus: 'pending' });
    expect(await repository.countHubNeedsReview(ownerUserId, { bookId: file.bookId })).toBe(1);
    expect(
      (await repository.findHubPaginated(ownerUserId, { bookId: file.bookId, needsReview: true }, { by: 'createdAt', dir: 'asc' }, 1, 25)).items,
    ).toHaveLength(1);
    const manual = await repository.create({ userId: ownerUserId, bookId: file.bookId, bookFileId: fileId, text: 'Manual source', cfi: '/source' });
    expect(await repository.findById(file.bookId, manual.id, ownerUserId)).toMatchObject({ cfi: '/source', cfiStatus: 'exact' });

    await module.close();
    await sync.close();
  }, 60_000);

  it('retains annotation source anchors across note edits and rejects another file revision', async () => {
    const [file] = await db.select().from(schema.bookFiles).where(eq(schema.bookFiles.id, fileId));
    const module = await Test.createTestingModule({
      providers: [AnnotationRepository, AnnotationSyncRepository, { provide: DB, useValue: db }],
    }).compile();
    const repository = module.get(AnnotationRepository);
    const sourceAnchor = {
      schemaVersion: 1 as const,
      bookId: file.bookId,
      bookFileId: fileId,
      revision: originalId,
      nativeLocator: { kind: 'cfi' as const, value: 'epubcfi(/6/2!/4/2/1:0)' },
      chapterIndex: 0,
      chapterFraction: 0,
      bookFraction: 0,
      quote: 'Original passage',
    };
    await catalog.requireRevision(fileId, originalId);
    await expect(catalog.requireRevision(fileId + 1, originalId)).rejects.toThrow('Revision not found for this file');
    const saved = await repository.create({
      userId: ownerUserId,
      bookId: file.bookId,
      bookFileId: fileId,
      cfi: sourceAnchor.nativeLocator.value,
      text: 'Original passage',
      sourceAnchor,
    });
    expect(saved.sourceAnchor).toEqual(sourceAnchor);
    const edited = await repository.update(file.bookId, saved.id, ownerUserId, { note: 'A later note', color: 'yellow' });
    expect(edited?.sourceAnchor).toEqual(sourceAnchor);
    expect(edited?.note).toBe('A later note');
    const sync = module.get(AnnotationSyncRepository);
    await db.transaction((tx) => sync.attachSourceAnchor(saved.id, ownerUserId, { ...sourceAnchor, quote: 'An older projection' }, tx));
    expect((await repository.findById(file.bookId, saved.id, ownerUserId))?.sourceAnchor).toEqual(sourceAnchor);
    const legacy = await repository.create({
      userId: ownerUserId,
      bookId: file.bookId,
      bookFileId: fileId,
      cfi: sourceAnchor.nativeLocator.value,
      text: 'Original passage',
    });
    await db.transaction((tx) => sync.attachSourceAnchor(legacy.id, ownerUserId + 1, sourceAnchor, tx));
    expect((await repository.findById(file.bookId, legacy.id, ownerUserId))?.sourceAnchor).toBeNull();
    await db.transaction((tx) => sync.attachSourceAnchor(legacy.id, ownerUserId, sourceAnchor, tx));
    const backfilled = await repository.findById(file.bookId, legacy.id, ownerUserId);
    expect(backfilled?.sourceAnchor).toEqual(sourceAnchor);
    expect(backfilled?.version).toBe(legacy.version);
    await module.close();
  });

  it('journals actual EPUB metadata writes without losing the story rollback copy or Kobo annotations', async () => {
    const story = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare');
    const installed = await service.resume(story.publicationId, libraryId);
    const [file] = await db.select().from(schema.bookFiles).where(eq(schema.bookFiles.id, fileId));
    await db.update(schema.books).set({ primaryFileId: fileId }).where(eq(schema.books.id, file.bookId));
    const [device] = await db.insert(schema.koboDevices).values({ userId: ownerUserId, name: 'Metadata device', token: randomUUID() }).returning();
    const [snapshot] = await db.insert(schema.koboLibrarySnapshots).values({ userId: ownerUserId, deviceId: device.id }).returning();
    await db
      .insert(schema.koboSnapshotBooks)
      .values({ snapshotId: snapshot.id, bookId: file.bookId, fileHash: file.fileHash, deliveryHash: file.fileHash, synced: true });
    const previousBytes = await readFile(target);
    const result = await locks.withLock(`book:${file.bookId}`, () =>
      metadata.rewriteWithinBookOperation(file.bookId, { id: fileId, libraryId, absolutePath: target }, async (path) => {
        expect(path).not.toBe(target);
        const written = await writer.write(path, { title: 'Updated metadata title' }, { fieldMask: createBookWriteFieldMask(), dryRun: false });
        expect(await readFile(target)).toEqual(previousBytes);
        return written;
      }),
    );
    expect(result.status).toBe('success');
    const [current] = await db.select().from(schema.bookFiles).where(eq(schema.bookFiles.id, fileId));
    expect(current.currentRevisionId).not.toBe(installed.revisionId);
    const history = await db.select().from(schema.bookFileRevisions).where(eq(schema.bookFileRevisions.bookFileId, fileId));
    expect(history.find((row) => row.id === current.currentRevisionId)).toMatchObject({ reason: 'file_write', changeKind: 'metadata' });
    expect(history.filter((row) => row.storagePath).map((row) => row.id)).toEqual([originalId]);
    const [copy] = await db.select().from(schema.koboSnapshotBooks).where(eq(schema.koboSnapshotBooks.snapshotId, snapshot.id));
    expect(copy).toMatchObject({ fileHash: current.fileHash, deliveryHash: file.fileHash, synced: true, pendingDelete: false });
  }, 30_000);
  it('refuses a metadata publication that changes chapter content or book assignment', async () => {
    await expect(service.prepare(fileId, libraryId, originalId, input, 'file_write')).rejects.toThrow('changed chapter content');
    expect((await requireInspectedFile(target)).sha256).toBe(originalSha);
    await expect(
      service.prepare(fileId, libraryId, originalId, input, 'file_write', undefined, undefined, { bookId: -1, absolutePath: target }),
    ).rejects.toThrow('assignment changed');
    expect(await db.select().from(schema.revisionPublications).where(eq(schema.revisionPublications.bookFileId, fileId))).toHaveLength(0);
  });
  it('recovers metadata publication when Kobo snapshot persistence interrupts the revision transaction', async () => {
    await copyFile(target, input);
    await writer.write(input, { title: 'Recovered metadata title' }, { fieldMask: createBookWriteFieldMask(), dryRun: false });
    const prepared = await service.prepare(fileId, libraryId, originalId, input, 'file_write');
    const save = vi.spyOn(koboFiles, 'preserveMetadataOnlyCopy').mockRejectedValueOnce(new Error('Simulated database interruption'));
    await expect(service.resume(prepared.publicationId, libraryId)).rejects.toThrow('Simulated database interruption');
    expect((await journal(prepared.publicationId)).state).toBe('filesystem_published');
    const [file] = await db.select().from(schema.bookFiles).where(eq(schema.bookFiles.id, fileId));
    expect(file.currentRevisionId).toBe(originalId);
    save.mockRestore();
    const recovered = await service.resume(prepared.publicationId, libraryId);
    expect(recovered.state).toBe('cleanup_complete');
    const history = await db.select().from(schema.bookFileRevisions).where(eq(schema.bookFileRevisions.bookFileId, fileId));
    expect(history).toHaveLength(2);
    expect(history.filter((row) => row.storagePath)).toHaveLength(0);
  });

  async function owner() {
    const [job] = await db
      .insert(schema.fanfictionJobs)
      .values({
        libraryId,
        userId: ownerUserId,
        tokenVersion: 0,
        idempotencyKey: randomUUID(),
        kind: 'preview',
        url: 'https://example.org/story/1',
        site: 'example.org',
        state: 'running',
        fence: 1,
        leaseOwner: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    return job!;
  }
  function authority(job: typeof schema.fanfictionJobs.$inferSelect): RevisionPublicationAuthority {
    return { ownerKey: job.id, authorize: (tx) => jobs.assertOwnership(job, tx) };
  }

  it('excludes owned journals from generic recovery and fences workers after a lease takeover', async () => {
    const first = await owner();
    const prepared = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare', authority(first));
    await service.recoverPending();
    expect((await journal(prepared.publicationId)).state).toBe('prepared');
    expect((await requireInspectedFile(target)).sha256).toBe(originalSha);
    await expect(service.resume(prepared.publicationId, libraryId)).rejects.toThrow('owning operation');
    await expect(service.cancel(prepared.publicationId, libraryId)).rejects.toThrow('owning operation');
    await db
      .update(schema.fanfictionJobs)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(schema.fanfictionJobs.id, first.id));
    const replacement = (await jobs.claim())!;
    expect(replacement.id).toBe(first.id);
    await expect(service.resume(prepared.publicationId, libraryId, authority(first))).rejects.toThrow('ownership expired');
    expect((await requireInspectedFile(target)).sha256).toBe(originalSha);
    expect(await service.prepare(fileId, libraryId, originalId, '/missing-after-restart', 'fanficfare', authority(replacement))).toEqual(prepared);
    await expect(service.resume(prepared.publicationId, libraryId, authority(replacement))).resolves.toMatchObject({ state: 'cleanup_complete' });
  });

  it('uses the current clock to reject a lease that expires inside the publication transaction', async () => {
    const job = await owner();
    const prepared = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare', authority(job));
    let checks = 0;
    const expiresDuringPublication: RevisionPublicationAuthority = {
      ownerKey: job.id,
      authorize: async (tx) => {
        await jobs.assertOwnership(job, tx);
        if (++checks === 1) {
          await tx
            .update(schema.fanfictionJobs)
            .set({ leaseExpiresAt: sql`clock_timestamp() + interval '10 milliseconds'` })
            .where(eq(schema.fanfictionJobs.id, job.id));
          await tx.execute(sql`select pg_sleep(0.02)`);
        }
      },
    };
    await expect(service.resume(prepared.publicationId, libraryId, expiresDuringPublication)).rejects.toThrow('ownership expired');
    expect((await requireInspectedFile(target)).sha256).toBe(originalSha);
    expect((await journal(prepared.publicationId)).state).toBe('prepared');
    await service.resume(prepared.publicationId, libraryId, authority(job));
  });

  it('discards staged bytes after cancellation and allows an explicit retry with the same operation', async () => {
    const job = await owner();
    const prepared = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare', authority(job));
    await db.update(schema.fanfictionJobs).set({ cancellationRequested: true, state: 'cancelled' }).where(eq(schema.fanfictionJobs.id, job.id));
    await recovery.recover();
    const cancelled = await journal(prepared.publicationId);
    expect(cancelled.state).toBe('failed');
    expect(cancelled.ownerSettledAt).not.toBeNull();
    await expect(readFile(cancelled.stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(cancelled.backupPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await requireInspectedFile(target)).sha256).toBe(originalSha);
    const [retry] = await db
      .update(schema.fanfictionJobs)
      .set({ cancellationRequested: false, state: 'running', fence: 2 })
      .where(eq(schema.fanfictionJobs.id, job.id))
      .returning();
    const next = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare', authority(retry));
    expect(next.publicationId).not.toBe(prepared.publicationId);
    await service.resume(next.publicationId, libraryId, authority(retry));
  });

  it('recovers installed bytes after cancellation and a lost completion acknowledgement without installing again', async () => {
    const job = await owner();
    const prepared = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare', authority(job));
    const initial = await journal(prepared.publicationId);
    await rename(initial.stagedPath, target);
    await db.update(schema.fanfictionJobs).set({ cancellationRequested: true, state: 'cancelled' }).where(eq(schema.fanfictionJobs.id, job.id));
    vi.spyOn(interruptions, 'acknowledge').mockRejectedValueOnce(new Error('lost recovery acknowledgement'));
    await recovery.recover();
    expect((await journal(prepared.publicationId)).state).toBe('cleanup_complete');
    expect((await journal(prepared.publicationId)).ownerSettledAt).toBeNull();
    expect((await db.select().from(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.id, job.id)))[0].state).toBe('cancelled');
    await recovery.recover();
    expect((await journal(prepared.publicationId)).ownerSettledAt).not.toBeNull();
    expect((await db.select().from(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.id, job.id)))[0]).toMatchObject({
      state: 'succeeded',
      result: { revisionId: initial.nextRevisionId },
    });
    expect((await requireInspectedFile(target)).sha256).toBe(initial.nextSha256);
    expect(await db.select().from(schema.bookFileRevisions).where(eq(schema.bookFileRevisions.bookFileId, fileId))).toHaveLength(2);
  });

  it('fences interruption recovery when a retry takes ownership before publication inspection', async () => {
    const job = await owner();
    const prepared = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare', authority(job));
    await db.update(schema.fanfictionJobs).set({ state: 'failed' }).where(eq(schema.fanfictionJobs.id, job.id));
    const settle = interruptions.settle.bind(interruptions);
    vi.spyOn(interruptions, 'settle').mockImplementationOnce(async (...args) => {
      await db
        .update(schema.fanfictionJobs)
        .set({ state: 'running', cancellationRequested: false, fence: 2 })
        .where(eq(schema.fanfictionJobs.id, job.id));
      return settle(...args);
    });
    await recovery.recover();
    expect((await journal(prepared.publicationId)).state).toBe('prepared');
    expect((await requireInspectedFile(target)).sha256).toBe(originalSha);
    expect((await journal(prepared.publicationId)).ownerSettledAt).toBeNull();
  });

  it('cleans an orphaned operation without publishing staged bytes', async () => {
    const job = await owner();
    const prepared = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare', authority(job));
    await db.delete(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.id, job.id));
    await recovery.recover();
    expect((await journal(prepared.publicationId)).state).toBe('failed');
    expect((await journal(prepared.publicationId)).ownerSettledAt).not.toBeNull();
    expect((await requireInspectedFile(target)).sha256).toBe(originalSha);
  });

  it('does not mistake identical staged bytes for a completed replacement after cancellation', async () => {
    const job = await owner();
    const prepared = await service.prepare(fileId, libraryId, originalId, target, 'rollback', authority(job));
    await db.update(schema.fanfictionJobs).set({ cancellationRequested: true, state: 'cancelled' }).where(eq(schema.fanfictionJobs.id, job.id));
    await recovery.recover();
    expect((await journal(prepared.publicationId)).state).toBe('failed');
    expect(await db.select().from(schema.bookFileRevisions).where(eq(schema.bookFileRevisions.bookFileId, fileId))).toHaveLength(1);
  });

  it('recovers a prepared operation and retains a verified previous EPUB', async () => {
    const prepared = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare');
    expect((await requireInspectedFile(target)).sha256).toBe(originalSha);
    await service.recoverPending();
    const row = await journal(prepared.publicationId);
    expect(row.state).toBe('cleanup_complete');
    expect((await requireInspectedFile(target)).sha256).toBe(row.nextSha256);
    const [retained] = await db.select().from(schema.bookFileRevisions).where(eq(schema.bookFileRevisions.id, originalId));
    expect((await requireInspectedFile(retained.storagePath!)).sha256).toBe(originalSha);
    await expect(readFile(row.backupPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const [file] = await db.select().from(schema.bookFiles).where(eq(schema.bookFiles.id, fileId));
    expect(file.currentRevisionId).toBe(row.nextRevisionId);
    await expect(service.resume(row.id, libraryId)).resolves.toMatchObject({ revisionId: row.nextRevisionId });
  });

  it('recovers after filesystem publication and a rolled-back database transaction', async () => {
    const prepared = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare');
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce((callback) =>
      transaction(async (tx) => {
        await callback(tx);
        throw new Error('injected crash before database commit');
      }),
    );
    await expect(service.resume(prepared.publicationId, libraryId)).rejects.toThrow('injected crash');
    const row = await journal(prepared.publicationId);
    expect(row.state).toBe('prepared');
    expect((await requireInspectedFile(target)).sha256).toBe(row.nextSha256);
    const [file] = await db.select().from(schema.bookFiles).where(eq(schema.bookFiles.id, fileId));
    expect(file.currentRevisionId).toBe(originalId);
    await expect(service.resume(row.id, libraryId)).resolves.toMatchObject({ state: 'cleanup_complete' });
    const revisions = await db.select().from(schema.bookFileRevisions).where(eq(schema.bookFileRevisions.bookFileId, fileId));
    expect(revisions).toHaveLength(2);
  });

  it.each([2, 3])('recovers a crash at durable transaction boundary %s', async (boundary) => {
    const { publicationId } = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare');
    const transaction = db.transaction.bind(db);
    let count = 0;
    const spy = vi.spyOn(db, 'transaction').mockImplementation((callback) =>
      transaction(async (tx) => {
        const result = await callback(tx);
        if (++count === boundary) throw new Error('injected durable checkpoint crash');
        return result;
      }),
    );
    await expect(service.resume(publicationId, libraryId)).rejects.toThrow('checkpoint crash');
    spy.mockRestore();
    expect((await journal(publicationId)).state).toBe(boundary === 2 ? 'filesystem_published' : 'database_committed');
    await expect(service.resume(publicationId, libraryId)).resolves.toMatchObject({ state: 'cleanup_complete' });
    const revisions = await db.select().from(schema.bookFileRevisions).where(eq(schema.bookFileRevisions.bookFileId, fileId));
    expect(revisions).toHaveLength(2);
  });

  it('retains one previous managed EPUB while keeping historical manifests', async () => {
    const first = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare');
    const installed = await service.resume(first.publicationId, libraryId);
    await db.update(schema.revisionPublications).set({ state: 'database_committed' }).where(eq(schema.revisionPublications.id, first.publicationId));
    await epub(input, 'Third version with more chapters');
    const second = await service.prepare(fileId, libraryId, installed.revisionId, input, 'fanficfare');
    await service.resume(second.publicationId, libraryId);
    const revisions = await db.select().from(schema.bookFileRevisions).where(eq(schema.bookFileRevisions.bookFileId, fileId));
    expect(revisions).toHaveLength(3);
    await expect(service.resume(first.publicationId, libraryId)).resolves.toMatchObject({ state: 'cleanup_complete' });
    expect(revisions.filter((r) => r.storagePath !== null).map((r) => r.id)).toEqual([installed.revisionId]);
    expect(revisions.every((r) => r.chapters.length > 0)).toBe(true);
    const page = await catalog.list(fileId, libraryId, 2);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const older = await catalog.list(fileId, libraryId, 2, page.nextCursor!);
    expect(older.items).toHaveLength(1);
    expect(older.nextCursor).toBeNull();
    expect(new Set([...page.items, ...older.items].map((item) => item.revision)).size).toBe(3);
    expect(page.items[0]).not.toHaveProperty('storagePath');
    await expect(catalog.list(fileId, libraryId + 1)).rejects.toThrow('not found');
    await expect(catalog.manifest(fileId, libraryId, originalId)).resolves.toMatchObject({ revision: originalId, sha256: originalSha });
    await expect(
      catalog.resolve(fileId, libraryId, installed.revisionId, {
        bookFileId: fileId + 1,
        revision: originalId,
        chapterIndex: 0,
        chapterFraction: 0.5,
        bookFraction: 0.5,
      }),
    ).rejects.toThrow('different book file');
    await expect(
      catalog.resolve(fileId, libraryId, installed.revisionId, { revision: originalId, chapterIndex: 0, chapterFraction: 0.5, bookFraction: 0.5 }),
    ).resolves.toMatchObject({ revision: installed.revisionId, quality: 'approximate' });

    await expect(readFile((await journal(first.publicationId)).backupPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent recovery without duplicate revisions', async () => {
    const { publicationId } = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare');
    const otherModule = await Test.createTestingModule({
      providers: [
        RevisionPublicationService,
        RevisionCoordinationService,
        KoboFileStateService,
        RevisionRetentionService,
        FileLockService,
        { provide: storageConfig.KEY, useValue: storage },
        { provide: EpubManifestService, useValue: manifests },
        { provide: DB, useValue: db },
      ],
    }).compile();
    const other = otherModule.get(RevisionPublicationService);
    const results = await Promise.all([service.resume(publicationId, libraryId), other.resume(publicationId, libraryId)]);
    await otherModule.close();
    expect(results[0]).toEqual(results[1]);
    const revisions = await db.select().from(schema.bookFileRevisions).where(eq(schema.bookFileRevisions.bookFileId, fileId));
    expect(revisions).toHaveLength(2);
  });

  it('retains rollback bytes across a whole book-folder rename', async () => {
    const first = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare');
    const installed = await service.resume(first.publicationId, libraryId);
    const folder = join(dir, 'renamed-books');
    await rename(dirname(target), folder);
    target = join(folder, 'renamed-story.epub');
    await rename(join(folder, 'story.epub'), target);
    await db.update(schema.bookFiles).set({ absolutePath: target }).where(eq(schema.bookFiles.id, fileId));
    const previous = await catalog.retained(fileId, libraryId, originalId, installed.revisionId);
    expect((await requireInspectedFile(previous.path)).sha256).toBe(originalSha);
    const rollback = await service.prepare(fileId, libraryId, installed.revisionId, previous.path, 'rollback', undefined, previous.sha256);
    const restored = await service.resume(rollback.publicationId, libraryId);
    expect(restored.revisionId).not.toBe(originalId);
    expect((await requireInspectedFile(target)).sha256).toBe(originalSha);
    expect((await catalog.list(fileId, libraryId)).items.filter((revision) => revision.canRollback)).toHaveLength(1);
  });

  it('rejects stale revision expectations, another library, and a second active replacement', async () => {
    await expect(service.prepare(fileId, libraryId, randomUUID(), input, 'fanficfare')).rejects.toThrow('Refresh');
    await expect(service.prepare(fileId, libraryId + 1, originalId, input, 'fanficfare')).rejects.toThrow('not found');
    const { publicationId } = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare');
    await expect(service.prepare(fileId, libraryId, originalId, input, 'fanficfare')).rejects.toThrow('already pending');
    await expect(service.resume(publicationId, libraryId + 1)).rejects.toThrow('not found');
  });

  it('does not overwrite an independently changed file or a damaged staged file', async () => {
    const { publicationId } = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare');
    const row = await journal(publicationId);
    await writeFile(target, 'independent replacement');
    await expect(service.resume(publicationId, libraryId)).rejects.toThrow('outside this publication');
    expect(await readFile(target, 'utf8')).toBe('independent replacement');
    await copyFile(row.backupPath, target);
    await writeFile(row.stagedPath, 'damaged staging');
    await expect(service.resume(publicationId, libraryId)).rejects.toThrow('no longer matches');
    expect((await requireInspectedFile(target)).sha256).toBe(originalSha);
  });

  it('keeps cancelled work from being recovered or installed', async () => {
    const { publicationId } = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare');
    await service.cancel(publicationId, libraryId);
    await service.recoverPending();
    expect((await journal(publicationId)).state).toBe('failed');
    expect((await requireInspectedFile(target)).sha256).toBe(originalSha);
    await expect(service.resume(publicationId, libraryId)).rejects.toThrow('cancelled');
  });
  it('serves immutable verified downloads and rejects stale or cross-library requests', async () => {
    const original = await readFile(target);
    const first = await downloads.download(fileId, libraryId, originalId, async () => {});
    const second = await downloads.download(fileId, libraryId, originalId, async () => {});
    await expect(downloads.download(fileId, libraryId, originalId, async () => {})).rejects.toThrow('capacity');
    const prepared = await service.prepare(fileId, libraryId, originalId, input, 'fanficfare');
    await service.resume(prepared.publicationId, libraryId);
    for (const snapshot of [first, second]) {
      const chunks: Buffer[] = [];
      for await (const chunk of snapshot.stream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks)).toEqual(original);
      expect(snapshot.sha256).toBe(originalSha);
    }
    await expect(downloads.download(fileId, libraryId, originalId, async () => {})).rejects.toThrow('no longer current');
    const row = await journal(prepared.publicationId);
    await expect(downloads.download(fileId, libraryId + 1, row.nextRevisionId, async () => {})).rejects.toThrow('not found');
    await writeFile(target, 'External replacement');
    await expect(downloads.download(fileId, libraryId, row.nextRevisionId, async () => {})).rejects.toThrow('size changed');
  });
});

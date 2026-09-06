import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipArchive } from 'archiver';
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FanfictionRecognizedUrl } from '@bookorbit/types';
import { DB } from '../src/db';
import * as schema from '../src/db/schema';
import type { RequestUser } from '../src/common/types/request-user';
import { BookRevisionService } from '../src/modules/book-revision/book-revision.service';
import { EpubManifestService } from '../src/modules/book-revision/epub-manifest.service';
import { RevisionCatalogService } from '../src/modules/book-revision/revision-catalog.service';
import { RevisionFileService } from '../src/modules/book-revision/revision-file.service';
import { FanfictionDiscoveryService } from '../src/modules/fanfiction/fanfiction-discovery.service';
import { FanfictionAdoptionService } from '../src/modules/fanfiction/fanfiction-adoption.service';
import { FanfictionJobService } from '../src/modules/fanfiction/fanfiction-job.service';
import { FanfictionAccessService } from '../src/modules/fanfiction/fanfiction-access.service';
import { FanfictionProfileService } from '../src/modules/fanfiction/fanfiction-profile.service';
import { FanficfareRuntimeService } from '../src/modules/fanfiction/fanficfare-runtime.service';

const configPath = process.env.REVISION_TEST_DB_CONFIG;
describe.skipIf(!configPath)('bounded existing EPUB discovery and adoption', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let module: TestingModule;
  let discovery: FanfictionDiscoveryService;
  let adoption: FanfictionAdoptionService;
  let jobs: FanfictionJobService;
  let directory: string;
  let libraryId: number;
  let folderId: number;
  let user: RequestUser;
  const authorize = vi.fn(() => Promise.resolve());
  const access = { administer: vi.fn(() => Promise.resolve()) };
  const runtime = {
    recognize: vi.fn((urls: string[]): Promise<FanfictionRecognizedUrl[]> =>
      Promise.resolve(urls.map((url) => ({ url, recognized: true, canonicalUrl: url, site: 'archiveofourown.org' }))),
    ),
  };
  const signal = () => new AbortController().signal;
  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (config.database !== 'bookorbit_revision_validation') throw new Error('Isolated validation database required');
    pool = new Pool({ ...config, connectionTimeoutMillis: 10_000, statement_timeout: 20_000 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../src/db/migrations') });
    const [created] = await db
      .insert(schema.users)
      .values({ username: `discovery-${randomUUID()}`, name: 'Discovery test', passwordHash: 'not-a-login-hash' })
      .returning();
    user = { ...created, permissions: [], contentFilters: {} } as RequestUser;
    module = await Test.createTestingModule({
      providers: [
        FanfictionDiscoveryService,
        FanfictionAdoptionService,
        FanfictionJobService,
        BookRevisionService,
        EpubManifestService,
        RevisionCatalogService,
        RevisionFileService,
        { provide: DB, useValue: db },
        { provide: FanfictionAccessService, useValue: access },
        { provide: FanfictionProfileService, useValue: { get: vi.fn() } },
        { provide: FanficfareRuntimeService, useValue: runtime },
      ],
    }).compile();
    discovery = module.get(FanfictionDiscoveryService);
    adoption = module.get(FanfictionAdoptionService);
    jobs = module.get(FanfictionJobService);
  }, 60_000);
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bookorbit-discovery-'));
    const [library] = await db
      .insert(schema.libraries)
      .values({ name: `discovery-${randomUUID()}` })
      .returning();
    libraryId = library.id;
    const [folder] = await db.insert(schema.libraryFolders).values({ libraryId, path: directory }).returning();
    folderId = folder.id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    authorize.mockReset();
    access.administer.mockReset();
    runtime.recognize.mockClear();
    await db.delete(schema.libraries).where(eq(schema.libraries.id, libraryId));
    await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => {
    await module?.close();
    if (user) await db.delete(schema.users).where(eq(schema.users.id, user.id));
    await pool?.end();
  });
  async function epub(urls = ['https://archiveofourown.org/works/123']) {
    const bookDirectory = join(directory, randomUUID());
    await mkdir(bookDirectory);
    const path = join(bookDirectory, 'story.epub');
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(path);
      const zip = new ZipArchive({ zlib: { level: 6 } });
      stream.on('close', resolve).on('error', reject);
      zip.on('error', reject);
      zip.pipe(stream);
      zip.append('application/epub+zip', { name: 'mimetype', store: true });
      zip.append('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>', { name: 'META-INF/container.xml' });
      zip.append(
        `<package><metadata><title>Existing story</title><creator>Writer</creator>${urls.map((url) => `<source>${url}</source>`).join('')}</metadata><manifest><item id="file0001" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="file0001"/></spine></package>`,
        { name: 'book.opf' },
      );
      zip.append('<html><body><p>Existing passage</p></body></html>', { name: 'c.xhtml' });
      void zip.finalize();
    });
    await utimes(path, new Date(0), new Date(0));
    const [book] = await db.insert(schema.books).values({ libraryId, libraryFolderId: folderId, folderPath: bookDirectory }).returning();
    const [file] = await db
      .insert(schema.bookFiles)
      .values({ bookId: book.id, libraryFolderId: folderId, absolutePath: path, ino: 1, format: 'epub' })
      .returning();
    return file;
  }
  async function scan() {
    const view = await discovery.start(libraryId, randomUUID(), user);
    const job = (await jobs.claim())!;
    expect(job.id).toBe(view.id);
    const result = await discovery.run(job, authorize, signal());
    await jobs.finish(job, 'succeeded', result);
    return result;
  }
  async function select(ids?: string[], decision: 'approve' | 'reject' = 'approve') {
    const view = await adoption.start(
      libraryId,
      { idempotencyKey: randomUUID(), state: 'pending', decision, ...(ids ? { ids } : { allMatching: true }) },
      user,
    );
    const job = (await jobs.claim())!;
    expect(job.id).toBe(view.id);
    return job;
  }
  const pending = () => discovery.list(libraryId, { state: 'pending', limit: 50 }, user);
  it('reserves one scan, excludes files added after its cutoff and advances past unavailable files', async () => {
    const missing = await epub();
    await rm(missing.absolutePath);
    const existing = await epub();
    const key = randomUUID();
    const view = await discovery.start(libraryId, key, user);
    const unrelated = Array.from({ length: 51 }, () => ({
      libraryId,
      userId: user.id,
      tokenVersion: user.tokenVersion,
      idempotencyKey: randomUUID(),
      kind: 'preview' as const,
      state: 'succeeded' as const,
      url: 'https://archiveofourown.org/works/123',
      site: 'archiveofourown.org',
    }));
    await db.insert(schema.fanfictionJobs).values(unrelated);
    expect((await jobs.list(libraryId, { kind: 'discovery', activeOnly: 'true', limit: 1 }, user)).items.map((row) => row.id)).toEqual([view.id]);

    expect((await discovery.start(libraryId, key, user)).id).toBe(view.id);
    await expect(discovery.start(libraryId, randomUUID(), user)).rejects.toThrow('already active');
    await epub(['https://archiveofourown.org/works/456']);
    const job = (await jobs.claim())!;
    const result = await discovery.run(job, authorize, signal());
    expect(result.discovery).toMatchObject({ scanned: 2, candidates: 1, failed: 1, finished: true, cursorFileId: existing.id });
    expect((await pending()).items.map((row) => row.bookFileId)).toEqual([existing.id]);
  });
  it('adopts in place and resumes after lost completion without creating another source or revision', async () => {
    const file = await epub();
    const bytes = await readFile(file.absolutePath);
    await scan();
    const [candidate] = (await pending()).items;
    const job = await select([candidate.id]);
    const result = await adoption.run(job, user, authorize, signal());
    expect(result.selection).toEqual({ processed: 1, failed: 0, finished: true });
    const [source] = await db.select().from(schema.fanfictionSources).where(eq(schema.fanfictionSources.libraryId, libraryId));
    expect(source).toMatchObject({ bookId: file.bookId, bookFileId: file.id, state: 'active' });
    expect(await readFile(file.absolutePath)).toEqual(bytes);
    await jobs.yieldBatch(job, result);
    await db
      .update(schema.fanfictionJobs)
      .set({ runAfter: sql`now()` })
      .where(eq(schema.fanfictionJobs.id, job.id));
    const resumed = (await jobs.claim())!;
    expect(await adoption.run(resumed, user, authorize, signal())).toEqual(result);
    expect(await db.select().from(schema.fanfictionSources).where(eq(schema.fanfictionSources.libraryId, libraryId))).toHaveLength(1);
    expect(await db.select().from(schema.bookFileRevisions).where(eq(schema.bookFileRevisions.bookFileId, file.id))).toHaveLength(1);
  }, 30_000);
  it('keeps all-matching selection fixed and makes selection identities immutable', async () => {
    await epub();
    await scan();
    const key = randomUUID();
    const dto = { idempotencyKey: key, state: 'pending' as const, decision: 'reject' as const, allMatching: true };
    const view = await adoption.start(libraryId, dto, user);
    expect((await adoption.start(libraryId, dto, user)).id).toBe(view.id);
    await expect(adoption.start(libraryId, { ...dto, decision: 'approve' }, user)).rejects.toThrow('reused');
    const original = (await pending()).items[0];
    await db
      .insert(schema.fanfictionDiscoveryCandidates)
      .values({ ...original, id: randomUUID(), sha256: 'b'.repeat(64), createdAt: new Date(Date.now() + 60_000) });
    const job = (await jobs.claim())!;
    expect((await adoption.run(job, user, authorize, signal())).selection).toEqual({ processed: 1, failed: 0, finished: true });
    expect((await pending()).items).toHaveLength(1);
  });
  it('rolls back source linking together with its cursor if authorization is revoked inside the transaction', async () => {
    await epub();
    await scan();
    const candidate = (await pending()).items[0];
    const job = await select([candidate.id]);
    authorize.mockResolvedValueOnce().mockRejectedValueOnce(new ForbiddenException('revoked'));
    await expect(adoption.run(job, user, authorize, signal())).rejects.toThrow('revoked');
    expect(await db.select().from(schema.fanfictionSources).where(eq(schema.fanfictionSources.libraryId, libraryId))).toHaveLength(0);
    expect((await pending()).items[0].id).toBe(candidate.id);
    const [stored] = await db.select().from(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.id, job.id));
    expect(stored.selection?.cursor).toBeNull();
  }, 30_000);
  it('retries only failed candidates from the original review and leaves successful links alone', async () => {
    await epub();
    const unavailable = await epub(['https://archiveofourown.org/works/456']);
    await scan();
    const original = (await pending()).items;
    await rm(unavailable.absolutePath);
    const job = await select();
    const result = await adoption.run(job, user, authorize, signal());
    expect(result.selection).toEqual({ processed: 2, failed: 1, finished: true });
    await jobs.finish(job, 'review_required', result, 'discovery_review_required');
    const failed = original.find((candidate) => candidate.bookFileId === unavailable.id)!;
    const retried = await jobs.retry(libraryId, job.id, user);
    expect(retried.result?.selection).toEqual({ processed: 0, failed: 0, finished: false });
    const next = (await jobs.claim())!;
    expect((await adoption.run(next, user, authorize, signal())).selection).toEqual({ processed: 1, failed: 1, finished: true });
    const reviewed = await discovery.list(libraryId, { state: 'failed', limit: 50 }, user);
    expect(reviewed.items[0]).toMatchObject({ id: failed.id, reviewJobId: job.id, errorCode: 'candidate_unavailable' });
    expect(await db.select().from(schema.fanfictionSources).where(eq(schema.fanfictionSources.libraryId, libraryId))).toHaveLength(1);
  }, 30_000);
  it('holds ambiguous metadata for an explicit recognized URL and rejects forged choices', async () => {
    await epub(['https://archiveofourown.org/works/123', 'https://archiveofourown.org/works/456']);
    await scan();
    const [candidate] = (await discovery.list(libraryId, { state: 'ambiguous', limit: 50 }, user)).items;
    await expect(
      adoption.start(libraryId, { idempotencyKey: randomUUID(), decision: 'approve', state: 'ambiguous', ids: [candidate.id] }, user),
    ).rejects.toThrow('explicit');
    await adoption.start(
      libraryId,
      {
        idempotencyKey: randomUUID(),
        decision: 'approve',
        state: 'ambiguous',
        ids: [candidate.id],
        canonicalUrl: 'https://archiveofourown.org/works/999',
      },
      user,
    );
    const job = (await jobs.claim())!;
    expect((await adoption.run(job, user, authorize, signal())).selection.failed).toBe(1);
    expect(await db.select().from(schema.fanfictionSources).where(eq(schema.fanfictionSources.libraryId, libraryId))).toHaveLength(0);
  });
  it('yields bounded batches without spending retry attempts and resumes the same cursor', async () => {
    await epub();
    await scan();
    const original = (await pending()).items[0];
    const rows = Array.from({ length: 100 }, (_, index) => ({
      ...original,
      id: randomUUID(),
      sha256: index.toString(16).padStart(64, '0'),
      createdAt: new Date(0),
    }));
    await db.insert(schema.fanfictionDiscoveryCandidates).values(rows);
    let job = await select(undefined, 'reject');
    let processed = 0;
    for (let batch = 0; batch < 20; batch++) {
      const result = await adoption.run(job, user, authorize, signal());
      expect(result.selection.processed - processed).toBeLessThanOrEqual(100);
      expect(result.selection.processed).toBeGreaterThan(processed);
      expect(result.selection.failed).toBe(0);
      processed = result.selection.processed;
      if (result.selection.finished) break;
      await jobs.yieldBatch(job, result);
      const [stored] = await db.select().from(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.id, job.id));
      expect(stored.attempts).toBe(0);
      await db
        .update(schema.fanfictionJobs)
        .set({ runAfter: sql`now()` })
        .where(eq(schema.fanfictionJobs.id, job.id));
      job = (await jobs.claim())!;
    }
    expect(processed).toBe(101);
    expect((await pending()).items).toHaveLength(0);
  }, 180_000);
  it('rejects foreign cursors and never adopts candidate IDs from another library', async () => {
    await epub();
    await scan();
    const candidate = (await pending()).items[0];
    const [other] = await db
      .insert(schema.libraries)
      .values({ name: `other-discovery-${randomUUID()}` })
      .returning();
    try {
      await expect(discovery.list(other.id, { cursor: candidate.id, state: 'pending', limit: 50 }, user)).rejects.toThrow('does not belong');
      await adoption.start(other.id, { idempotencyKey: randomUUID(), state: 'pending', decision: 'approve', ids: [candidate.id] }, user);
      const job = (await jobs.claim())!;
      expect((await adoption.run(job, user, authorize, signal())).selection).toEqual({ processed: 0, failed: 0, finished: true });
      expect((await pending()).items[0].state).toBe('pending');
      access.administer.mockRejectedValueOnce(new ForbiddenException('not a library administrator'));
      await expect(discovery.start(libraryId, randomUUID(), user)).rejects.toThrow('not a library administrator');
    } finally {
      await db.delete(schema.libraries).where(eq(schema.libraries.id, other.id));
    }
  });
  it('fences an expired discovery worker before it can publish candidates or cursor progress', async () => {
    const file = await epub();
    await rm(file.absolutePath);
    await discovery.start(libraryId, randomUUID(), user);
    const expired = (await jobs.claim())!;
    await db
      .update(schema.fanfictionJobs)
      .set({ leaseExpiresAt: sql`now() - interval '1 minute'` })
      .where(eq(schema.fanfictionJobs.id, expired.id));
    const takeover = (await jobs.claim())!;
    expect(takeover.fence).toBe(expired.fence + 1);
    await expect(discovery.run(expired, authorize, signal())).rejects.toThrow();
    const [stored] = await db.select().from(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.id, expired.id));
    expect(stored.discovery?.cursorFileId).toBe(0);
    expect((await discovery.run(takeover, authorize, signal())).discovery.scanned).toBe(1);
  });
  it('does not consume the scan cursor when the pinned runtime is configuration-blocked', async () => {
    await epub();
    await discovery.start(libraryId, randomUUID(), user);
    const job = (await jobs.claim())!;
    runtime.recognize.mockRejectedValueOnce(new BadRequestException({ errorCode: 'configuration_blocked' }));
    await expect(discovery.run(job, authorize, signal())).rejects.toThrow(BadRequestException);
    const [stored] = await db.select().from(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.id, job.id));
    expect(stored.discovery?.cursorFileId).toBe(0);
  });
});

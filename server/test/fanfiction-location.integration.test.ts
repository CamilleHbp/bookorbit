import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from '../src/db';
import * as schema from '../src/db/schema';
import type { RequestUser } from '../src/common/types/request-user';
import { FanfictionLocationService } from '../src/modules/fanfiction/fanfiction-location.service';
import { ManagedTagService } from '../src/modules/metadata/managed-tag.service';
import { FanfictionSourceService } from '../src/modules/fanfiction/fanfiction-source.service';
import { FanfictionJobService } from '../src/modules/fanfiction/fanfiction-job.service';
import { FanfictionAccessService } from '../src/modules/fanfiction/fanfiction-access.service';
import { FanfictionProfileService } from '../src/modules/fanfiction/fanfiction-profile.service';
import { RevisionCoordinationService } from '../src/modules/book-revision/revision-coordination.service';
import { FileRenameRepository } from '../src/modules/file-write/file-rename.repository';
import { BookMoveRepository } from '../src/modules/book-move/book-move.repository';
import { LibraryService } from '../src/modules/library/library.service';
import { AppSettingsService } from '../src/modules/app-settings/app-settings.service';
import { UploadValidatorService } from '../src/modules/upload/upload-validator.service';

const configPath = process.env.REVISION_TEST_DB_CONFIG;
describe.skipIf(!configPath)('managed story relocation', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let module: TestingModule;
  let user: RequestUser;
  let libraryIds: number[] = [];
  let folders: (typeof schema.libraryFolders.$inferSelect)[];
  let book: typeof schema.books.$inferSelect;
  let file: typeof schema.bookFiles.$inferSelect;
  let source: typeof schema.fanfictionSources.$inferSelect;
  let coordination: RevisionCoordinationService;
  let sources: FanfictionSourceService;
  let jobs: FanfictionJobService;
  let rename: FileRenameRepository;
  let move: BookMoveRepository;
  const profiles = { document: vi.fn(() => Promise.resolve({})) };

  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (config.database !== 'bookorbit_revision_validation') throw new Error('Isolated validation database required');
    pool = new Pool({ ...config, connectionTimeoutMillis: 10_000, statement_timeout: 20_000 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../src/db/migrations') });
    const [created] = await db
      .insert(schema.users)
      .values({ username: `relocation-${randomUUID()}`, name: 'Relocation test', passwordHash: 'not-a-login-hash' })
      .returning();
    user = { ...created, permissions: [], contentFilters: {} } as RequestUser;
    module = await Test.createTestingModule({
      providers: [
        FanfictionLocationService,
        FanfictionSourceService,
        ManagedTagService,
        FanfictionJobService,
        RevisionCoordinationService,
        FileRenameRepository,
        BookMoveRepository,
        { provide: DB, useValue: db },
        { provide: FanfictionAccessService, useValue: { administer: vi.fn(() => Promise.resolve()) } },
        { provide: FanfictionProfileService, useValue: profiles },
        { provide: LibraryService, useValue: {} },
        { provide: AppSettingsService, useValue: {} },
        { provide: UploadValidatorService, useValue: {} },
      ],
    }).compile();
    coordination = module.get(RevisionCoordinationService);
    sources = module.get(FanfictionSourceService);
    jobs = module.get(FanfictionJobService);
    rename = module.get(FileRenameRepository);
    move = module.get(BookMoveRepository);
  }, 60_000);
  beforeEach(async () => {
    const libraries = await db
      .insert(schema.libraries)
      .values([{ name: `relocation-${randomUUID()}` }, { name: `relocation-${randomUUID()}` }])
      .returning();
    libraryIds = libraries.map((row) => row.id);
    folders = await db
      .insert(schema.libraryFolders)
      .values(libraryIds.map((libraryId) => ({ libraryId, path: `/validation/${libraryId}` })))
      .returning();
    [book] = await db
      .insert(schema.books)
      .values({ libraryId: libraryIds[0], libraryFolderId: folders[0].id, folderPath: `${folders[0].path}/story` })
      .returning();
    [file] = await db
      .insert(schema.bookFiles)
      .values({
        bookId: book.id,
        libraryFolderId: folders[0].id,
        absolutePath: `${book.folderPath}/story.epub`,
        relPath: 'story/story.epub',
        ino: 1,
        format: 'epub',
      })
      .returning();
    [source] = await db
      .insert(schema.fanfictionSources)
      .values({
        libraryId: libraryIds[0],
        folderId: folders[0].id,
        createdBy: user.id,
        bookId: book.id,
        bookFileId: file.id,
        canonicalUrl: 'https://archiveofourown.org/works/123',
        canonicalKey: '1'.repeat(64),
        site: 'archiveofourown.org',
        title: 'Story',
        state: 'active',
        importOperationId: randomUUID(),
        relativePath: file.relPath!,
        nextCheckAt: new Date(),
      })
      .returning();
    profiles.document.mockClear();
  });
  afterEach(async () => {
    await db.delete(schema.libraries).where(inArray(schema.libraries.id, libraryIds));
    libraryIds = [];
  });
  afterAll(async () => {
    await module?.close();
    if (user) await db.delete(schema.users).where(eq(schema.users.id, user.id));
    await pool?.end();
  });
  const current = async () => (await db.select().from(schema.fanfictionSources).where(eq(schema.fanfictionSources.id, source.id)))[0];
  const moveInput = () => ({
    bookId: book.id,
    targetLibraryId: libraryIds[1],
    targetFolderId: folders[1].id,
    targetFolderPathKey: `${folders[1].path}/renamed`,
    fileUpdates: [
      {
        fileId: file.id,
        absolutePath: `${folders[1].path}/renamed/story.epub`,
        relPath: 'renamed/story.epub',
        ino: 2n,
        sizeBytes: 10,
        mtime: new Date(),
      },
    ],
  });
  it('keeps the source identity and version through rename and rename rollback', async () => {
    await rename.applyFolderRename(
      book.id,
      [{ id: file.id, absolutePath: `${folders[0].path}/renamed.epub`, relPath: 'renamed.epub' }],
      folders[0].path,
    );
    expect(await current()).toMatchObject({
      id: source.id,
      bookId: book.id,
      bookFileId: file.id,
      relativePath: 'renamed.epub',
      version: source.version,
    });
    await rename.applyFolderRename(book.id, [{ id: file.id, absolutePath: file.absolutePath, relPath: file.relPath }], book.folderPath);
    expect(await current()).toMatchObject({ relativePath: file.relPath, state: 'active', version: source.version });
  });
  it('pauses cross-library moves, invalidates discovery and requires an explicit destination profile choice', async () => {
    const [profile] = await db
      .insert(schema.fanfictionProfiles)
      .values({
        id: randomUUID(),
        libraryId: libraryIds[0],
        name: 'Old library account',
        document: { version: 1, keyId: 'test-key', iv: '', tag: '', ciphertext: '' },
      })
      .returning();
    await db.update(schema.fanfictionSources).set({ profileId: profile.id }).where(eq(schema.fanfictionSources.id, source.id));
    const oldJob = await sources.check(libraryIds[0], source.id, 'update', randomUUID(), user);
    await db.insert(schema.fanfictionDiscoveryCandidates).values({
      libraryId: libraryIds[0],
      bookId: book.id,
      bookFileId: file.id,
      sha256: 'a'.repeat(64),
      title: 'Story',
      chapterCount: 1,
      urls: [],
      state: 'linked',
      sourceId: source.id,
    });
    await move.applyBookMove(moveInput());
    const moved = await current();
    expect(moved).toMatchObject({
      id: source.id,
      bookId: book.id,
      bookFileId: file.id,
      libraryId: libraryIds[1],
      folderId: folders[1].id,
      profileId: null,
      state: 'paused',
      nextCheckAt: null,
      attentionCode: 'destination_profile_required',
      version: source.version + 1,
      relativePath: 'renamed/story.epub',
    });
    expect(await db.select().from(schema.fanfictionDiscoveryCandidates).where(eq(schema.fanfictionDiscoveryCandidates.bookFileId, file.id))).toEqual(
      [],
    );
    await expect(sources.get(libraryIds[0], source.id, user)).rejects.toThrow();
    await expect(sources.check(libraryIds[1], source.id, 'update', randomUUID(), user)).rejects.toThrow('destination library profile');
    await expect(jobs.updateStory(moved, 'update', randomUUID(), user)).rejects.toThrow('requires attention');
    await expect(sources.update(libraryIds[1], source.id, { version: moved.version, state: 'active' }, user)).rejects.toThrow(
      'destination library profile',
    );
    const claimed = (await jobs.claim())!;
    expect(claimed.id).toBe(oldJob.id);
    await expect(sources.updateContext(claimed)).rejects.toThrow('settings changed');
    await jobs.finish(claimed, 'configuration_blocked', null, 'configuration_blocked');
    expect(await current()).toMatchObject({ state: 'paused', attentionCode: 'destination_profile_required' });
    await expect(jobs.retry(libraryIds[0], oldJob.id, user)).rejects.toThrow('settings changed');
    const selected = await sources.update(libraryIds[1], source.id, { version: moved.version, profileId: null }, user);
    expect(selected).toMatchObject({ state: 'paused', attentionCode: null });
    const resumed = await sources.update(libraryIds[1], source.id, { version: selected.version, state: 'active' }, user);
    expect(resumed.state).toBe('active');
    expect(profiles.document).not.toHaveBeenCalled();
    const [stale] = await db.select().from(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.id, oldJob.id));
    expect(stale.libraryId).toBe(libraryIds[0]);
    expect(stale.sourceVersion).toBe(source.version);
  });
  it('rolls back book and source changes when the destination canonical source already exists', async () => {
    await db.insert(schema.fanfictionSources).values({
      ...source,
      id: randomUUID(),
      libraryId: libraryIds[1],
      folderId: folders[1].id,
      bookId: null,
      bookFileId: null,
      importOperationId: randomUUID(),
    });
    await expect(move.applyBookMove(moveInput())).rejects.toThrow('already has this story');
    expect(await current()).toMatchObject({ libraryId: libraryIds[0], version: source.version, state: 'active' });
    expect((await db.select().from(schema.books).where(eq(schema.books.id, book.id)))[0].libraryId).toBe(libraryIds[0]);
    expect((await db.select().from(schema.bookFiles).where(eq(schema.bookFiles.id, file.id)))[0].absolutePath).toBe(file.absolutePath);
  });
  it('refuses implicit folder merges that would delete a managed source', async () => {
    const [target] = await db
      .insert(schema.books)
      .values({ libraryId: libraryIds[0], libraryFolderId: folders[0].id, folderPath: `${folders[0].path}/target` })
      .returning();
    await expect(
      rename.applyExistingFolderMerge({ sourceBookId: book.id, targetBookId: target.id, updates: [], fallbackPrimaryFileId: file.id }),
    ).rejects.toThrow('managed story');
    await expect(
      move.applyBookMove({
        ...moveInput(),
        bookId: target.id,
        targetLibraryId: libraryIds[0],
        targetFolderId: folders[0].id,
        fileUpdates: [],
        mergeDuplicateBookId: book.id,
      }),
    ).rejects.toThrow('managed story');
    expect(await current()).toMatchObject({ bookId: book.id, bookFileId: file.id });
  });
  it('serializes relocation with publication locks and rejects stale move plans', async () => {
    await coordination.withRelocation([file.id, file.id], async () => {
      await db.transaction(async (tx) => {
        const result = await tx.execute(sql`select pg_try_advisory_xact_lock(183726, ${file.id}) as acquired`);
        expect(result.rows[0].acquired).toBe(false);
      });
    });
    await db.transaction(async (tx) => {
      const result = await tx.execute(sql`select pg_try_advisory_xact_lock(183726, ${file.id}) as acquired`);
      expect(result.rows[0].acquired).toBe(true);
    });
    const relocate = vi.fn(() => Promise.resolve());
    await expect(coordination.withRelocation([file.id], relocate, [{ fileId: file.id, bookId: book.id, path: '/stale.epub' }])).rejects.toThrow(
      'location changed',
    );
    expect(relocate).not.toHaveBeenCalled();
  });
  it.each(['prepared', 'filesystem_published', 'database_committed', 'cleanup_complete', 'failed'] as const)(
    'blocks relocation until the %s publication is settled',
    async (state) => {
      const journalId = randomUUID();
      await db.insert(schema.revisionPublications).values({
        id: journalId,
        bookFileId: file.id,
        libraryId: libraryIds[0],
        expectedBookId: book.id,
        expectedRevisionId: randomUUID(),
        nextRevisionId: randomUUID(),
        targetPath: file.absolutePath,
        stagedPath: '/validation/staged',
        backupPath: '/validation/backup',
        previousSha256: 'a'.repeat(64),
        nextSha256: 'b'.repeat(64),
        nextFileHash: 'c'.repeat(32),
        nextSizeBytes: 10,
        reason: 'fanficfare',
        ownerKey: randomUUID(),
        state,
        manifest: { version: 1, chapters: [], contentHash: 'd'.repeat(64), metadataHash: 'e'.repeat(64), coverHash: null },
      });
      const relocate = vi.fn(() => Promise.resolve());
      await expect(coordination.withRelocation([file.id], relocate)).rejects.toThrow('finish recovery');
      expect(relocate).not.toHaveBeenCalled();
      await db
        .update(schema.revisionPublications)
        .set({ state: 'cleanup_complete', ownerSettledAt: new Date() })
        .where(eq(schema.revisionPublications.id, journalId));
      await coordination.withRelocation([file.id], relocate);
      expect(relocate).toHaveBeenCalledOnce();
    },
  );
});

import { backfillMatchingSnapshots } from '../src/modules/tag-matching/tag-matching-backfill';
import { TagMatchingJobsService } from '../src/modules/tag-matching/tag-matching-jobs.service';
import { importMatchingSeed } from '../src/modules/tag-matching/tag-matching-seed';
import { TagMatchingLifecycleService } from '../src/modules/tag-matching/tag-matching-lifecycle.service';
import { TagStrategy } from '../src/modules/entity-manager/strategies/tag.strategy';
import { GenreStrategy } from '../src/modules/entity-manager/strategies/genre.strategy';
import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from '../src/db';
import * as s from '../src/db/schema';
import type { RequestUser } from '../src/common/types/request-user';
import { TagMatchingService } from '../src/modules/tag-matching/tag-matching.service';
import { TagMatchingManagementService } from '../src/modules/tag-matching/tag-matching-management.service';
import { LibraryService } from '../src/modules/library/library.service';
import { MatchingPageDto } from '../src/modules/tag-matching/tag-matching.dto';
import type { IncomingLabel } from '@bookorbit/types';
const configPath = process.env.TAG_MATCHING_TEST_DB_CONFIG;
describe.skipIf(!configPath)('persistent tag matching', () => {
  let pool: Pool, db: ReturnType<typeof drizzle<typeof s>>, module: TestingModule;
  let matching: TagMatchingService, management: TagMatchingManagementService;
  let user: RequestUser, libraryId: number, bookId: number, tagId: number, genreId: number;
  let tagName: string, genreName: string;
  const sync = (labels: IncomingLabel[], sourceKey = 'file:metadata') =>
    db.transaction((tx) => matching.sync(tx, bookId, { source: 'file', sourceKey, labels }));
  const tags = () => db.select().from(s.bookTags).where(eq(s.bookTags.bookId, bookId));
  const genres = () => db.select().from(s.bookGenres).where(eq(s.bookGenres.bookId, bookId));
  async function save(field: 'tags' | 'genres', value: string, targets: Array<{ field: 'tags' | 'genres'; id: number }>, source = '') {
    const own = await management.own(user);
    return management.save(user, { version: own!.version, source, field, value, action: targets.length ? 'match' : 'ignore', targets });
  }
  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (!/^bookorbit_tagmatch_test_[0-9]+$/.test(config.database ?? '')) throw new Error('Dedicated tag-matching test database required');
    pool = new Pool({ ...config, max: 2, statement_timeout: 10000 });
    db = drizzle(pool, { schema: s });
    module = await Test.createTestingModule({
      providers: [
        TagMatchingService,
        TagMatchingJobsService,
        TagMatchingLifecycleService,
        TagStrategy,
        GenreStrategy,
        TagMatchingManagementService,
        { provide: DB, useValue: db },
        {
          provide: LibraryService,
          useValue: { findAccessibleLibraryIds: () => Promise.resolve([libraryId]), verifyAdministration: () => Promise.resolve(undefined) },
        },
      ],
    }).compile();
    matching = module.get(TagMatchingService);
    management = module.get(TagMatchingManagementService);
  });
  beforeEach(async () => {
    const id = randomUUID();
    const [u] = await db
      .insert(s.users)
      .values({ username: `tagmatch-${id}`, name: 'Test', passwordHash: 'unused' })
      .returning();
    user = { ...u, permissions: [], contentFilters: {}, settings: {}, isSuperuser: true } as unknown as RequestUser;
    const [lib] = await db
      .insert(s.libraries)
      .values({ name: `tagmatch-${id}` })
      .returning();
    libraryId = lib.id;
    const [folder] = await db
      .insert(s.libraryFolders)
      .values({ libraryId, path: `/test/${id}` })
      .returning();
    const [book] = await db
      .insert(s.books)
      .values({ libraryId, libraryFolderId: folder.id, folderPath: `/test/${id}` })
      .returning();
    bookId = book.id;
    await db.insert(s.bookMetadata).values({ bookId, title: 'Fixture' });
    tagName = `tagmatch-${id}`;
    genreName = `genre-${id}`;
    const [tag] = await db.insert(s.tags).values({ name: tagName }).returning();
    tagId = tag.id;
    const [genre] = await db.insert(s.genres).values({ name: genreName }).returning();
    genreId = genre.id;
    await management.attach(user, libraryId);
  });
  afterEach(async () => {
    await db.delete(s.libraries).where(eq(s.libraries.id, libraryId));
    await db.delete(s.users).where(eq(s.users.id, user.id));
    await db.delete(s.tags).where(eq(s.tags.id, tagId));
    await db.delete(s.genres).where(eq(s.genres.id, genreId));
  });
  afterAll(async () => {
    await module?.close();
    await pool?.end();
  });
  it('migrates website rules through approved targets without overriding cleanup suppression', async () => {
    await save('tags', 'old target', [{ field: 'tags', id: tagId }]);
    await save('tags', 'Character', []);
    const legacy = [
      { remoteTag: 'remote', targetTag: 'old target' },
      { remoteTag: 'Character', targetTag: tagName },
      { remoteTag: 'ambiguous', targetTag: 'missing canonical destination' },
    ];
    expect(await db.transaction((tx) => matching.importLegacyRules(tx, user, 'site.test', legacy))).toBe(2);
    const version = (await management.own(user))!.version;
    expect(await db.transaction((tx) => matching.importLegacyRules(tx, user, 'site.test', legacy))).toBe(0);
    expect((await management.own(user))!.version).toBe(version);
    await matching.importLabels(bookId, {
      source: 'site.test',
      sourceKey: 'fiction:test',
      labels: legacy.map((rule) => ({ field: 'tags' as const, value: rule.remoteTag })),
    });
    expect((await tags()).map((row) => row.tagId)).toEqual([tagId]);
    expect((await management.review(user, new MatchingPageDto())).items.map((row) => row.value)).toEqual(['ambiguous']);
    await expect(
      db.transaction((tx) => matching.importLegacyRules(tx, { ...user, isSuperuser: false, permissions: [] }, 'site.test', legacy)),
    ).rejects.toThrow('permission');
  });
  it('requires a concrete preview and applies only the approved change', async () => {
    await sync([{ field: 'tags', value: 'remote' }]);
    await save('tags', 'remote', [{ field: 'tags', id: tagId }]);
    const jobs = module.get(TagMatchingJobsService);
    const preview = await jobs.create(user, []);
    await expect(jobs.apply(user, preview.id)).rejects.toThrow('complete preview');
    expect(await tags()).toEqual([]);
    expect((await jobs.advance(user, preview.id)).state).toBe('ready');
    const page = await jobs.items(user, preview.id, 1, 25);
    expect(page.items[0].change.addedTags).toEqual([tagName]);
    expect(await tags()).toEqual([]);
    await jobs.apply(user, preview.id);
    expect((await jobs.advance(user, preview.id)).state).toBe('completed');
    expect((await tags()).map((row) => row.tagId)).toEqual([tagId]);
    await expect(jobs.items({ ...user, id: user.id + 100000 }, preview.id, 1, 25)).rejects.toThrow('not available');
  });
  it('shows paginated preview labels and protected changes without allowing empty application', async () => {
    await sync([
      { field: 'tags', value: 'remote' },
      { field: 'tags', value: 'unknown' },
      { field: 'characters', value: 'Named character' },
    ]);
    await save('tags', 'remote', [{ field: 'tags', id: tagId }]);
    await db
      .update(s.bookMetadata)
      .set({ lockedFields: ['tags'] })
      .where(eq(s.bookMetadata.bookId, bookId));
    const jobs = module.get(TagMatchingJobsService);
    const job = await jobs.create(user, []);
    await jobs.advance(user, job.id);
    const detail = await jobs.details(user, job.id, bookId, 1, 25);
    expect(detail.change.addedTags).toEqual([]);
    expect(detail.protectedChanges.addedTags).toEqual([tagName]);
    expect(detail.labels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'unknown', status: 'pending' }),
        expect.objectContaining({ value: 'Named character', status: 'suppressed', targets: [] }),
        expect.objectContaining({ status: 'missing-fandom' }),
        expect.objectContaining({ value: 'remote', status: 'matched', targets: [{ field: 'tags', id: tagId, name: tagName, excluded: false }] }),
      ]),
    );
    expect((await jobs.details(user, job.id, bookId, 2, 1)).labels).toHaveLength(1);
    await expect(jobs.apply(user, job.id)).rejects.toThrow('no changes');
    await expect(jobs.details({ ...user, id: user.id + 100000 }, job.id, bookId, 1, 25)).rejects.toThrow('not available');
    await expect(jobs.details(user, job.id, bookId + 100000, 1, 25)).rejects.toThrow('not available');
    await db.update(s.bookMetadata).set({ title: 'Changed' }).where(eq(s.bookMetadata.bookId, bookId));
    await expect(jobs.details(user, job.id, bookId, 1, 25)).rejects.toThrow('new preview');
  });
  it('retains same-named tag and genre destinations through EPUB subjects', async () => {
    await db.update(s.genres).set({ name: tagName }).where(eq(s.genres.id, genreId));
    await save('tags', 'remote', [
      { field: 'tags', id: tagId },
      { field: 'genres', id: genreId },
    ]);
    await sync([{ field: 'genres', value: tagName }]);
    expect((await tags()).map((row) => row.tagId)).toEqual([tagId]);
    expect((await genres()).map((row) => row.genreId)).toEqual([genreId]);
  });
  it('does not request fandom review for an explicitly original work', async () => {
    await save('tags', 'Original Work', []);
    await sync(
      [
        { field: 'characters', value: 'Named character' },
        { field: 'tags', value: ' Original   Work ' },
      ],
      'fanfiction:test',
    );
    expect((await management.review(user, new MatchingPageDto())).total).toBe(0);
    const jobs = module.get(TagMatchingJobsService);
    const preview = await jobs.create(user, []);
    await jobs.advance(user, preview.id);
    expect((await jobs.items(user, preview.id, 1, 25)).items[0].change.unresolved).toBe(0);
  });
  it('reviews missing fandoms per book without creating character aliases', async () => {
    await sync([{ field: 'characters', value: 'Named character' }], 'fanfiction:test');
    const own = (await management.own(user))!;
    const review = await management.review(user, new MatchingPageDto());
    expect(review.items).toHaveLength(1);
    expect(review.items[0]).toMatchObject({ bookId, sourceKey: 'fanfiction:test', field: 'fandoms' });
    await management.save(user, {
      version: own.version,
      bookId,
      sourceKey: 'fanfiction:test',
      source: 'file',
      field: 'fandoms',
      value: 'Missing fandom',
      action: 'match',
      targets: [{ field: 'tags', id: tagId }],
    });
    expect((await tags()).map((row) => row.tagId)).toEqual([tagId]);
    expect((await tags())[0].managedOnly).toBe(false);
    expect((await management.review(user, new MatchingPageDto())).total).toBe(0);
    expect((await management.list(user, new MatchingPageDto())).total).toBe(0);
    await sync([{ field: 'characters', value: 'Another character' }], 'fanfiction:test');
    expect((await tags()).map((row) => row.tagId)).toEqual([tagId]);
    expect((await management.review(user, new MatchingPageDto())).total).toBe(0);
  });
  it('keeps locked fandom assignments and denies another account a book-specific decision', async () => {
    await sync([{ field: 'characters', value: 'Named character' }], 'fanfiction:test');
    await db
      .update(s.bookMetadata)
      .set({ lockedFields: ['tags'] })
      .where(eq(s.bookMetadata.bookId, bookId));
    const own = (await management.own(user))!;
    const decision = {
      version: own.version,
      bookId,
      sourceKey: 'fanfiction:test',
      source: 'file',
      field: 'fandoms' as const,
      value: 'Missing fandom',
      action: 'match' as const,
      targets: [{ field: 'tags' as const, id: tagId }],
    };
    await expect(management.save(user, decision)).rejects.toThrow('Unlock');
    await expect(management.save({ ...user, id: user.id + 100000 }, decision)).rejects.toThrow('not available');
    expect(await tags()).toEqual([]);
    expect((await management.review(user, new MatchingPageDto())).total).toBe(1);
    await management.save(user, { ...decision, action: 'ignore', targets: [] });
    await sync([{ field: 'characters', value: 'Named character' }], 'fanfiction:test');
    expect((await management.review(user, new MatchingPageDto())).total).toBe(0);
  });
  it('skips reapplication when library editing access is revoked after preview', async () => {
    await sync([{ field: 'tags', value: 'remote' }]);
    await save('tags', 'remote', [{ field: 'tags', id: tagId }]);
    await db.insert(s.userLibraryAccess).values({ userId: user.id, libraryId, accessLevel: 'editor' });
    const editor = {
      ...user,
      isSuperuser: false,
      contentFilters: { includeTagIds: [], excludeTagIds: [], includeGenreIds: [], excludeGenreIds: [] },
    };
    const jobs = module.get(TagMatchingJobsService);
    const preview = await jobs.create(editor, []);
    await jobs.advance(editor, preview.id);
    expect((await jobs.items(editor, preview.id, 1, 25)).items).toHaveLength(1);
    await db.update(s.userLibraryAccess).set({ accessLevel: 'viewer' }).where(eq(s.userLibraryAccess.userId, user.id));
    await jobs.apply(editor, preview.id);
    expect(await jobs.advance(editor, preview.id)).toMatchObject({ state: 'completed', skipped: 1, changed: 0 });
    expect(await tags()).toEqual([]);
    const unavailable = await jobs.create(editor, []);
    expect((await jobs.items(editor, unavailable.id, 1, 25)).total).toBe(0);
  });
  it('resumes bounded batches and never treats a failed preview as approval', async () => {
    await sync([{ field: 'tags', value: 'remote' }]);
    const [first] = await db.select().from(s.books).where(eq(s.books.id, bookId));
    const additional = await db
      .insert(s.books)
      .values(Array.from({ length: 10 }, (_, i) => ({ libraryId, libraryFolderId: first.libraryFolderId, folderPath: `${first.folderPath}/${i}` })))
      .returning({ id: s.books.id });
    await db.insert(s.bookMetadata).values(additional.map((b) => ({ bookId: b.id, title: 'Batch fixture' })));
    const own = (await management.own(user))!;
    await db.insert(s.tagMatchingSnapshots).values(
      additional.map((b) => ({
        bookId: b.id,
        sourceKey: 'file:metadata',
        source: 'file',
        userId: user.id,
        rulebookId: own.id,
        version: own.version,
        labels: [{ field: 'tags' as const, value: 'remote' }],
      })),
    );
    await save('tags', 'remote', [{ field: 'tags', id: tagId }]);
    const jobs = module.get(TagMatchingJobsService);
    const preview = await jobs.create(user, []);
    const failedRead = vi.spyOn(matching, 'resolve').mockRejectedValueOnce(new Error('Temporary read failure'));
    try {
      await expect(jobs.advance(user, preview.id)).rejects.toThrow('Temporary read failure');
    } finally {
      failedRead.mockRestore();
    }
    expect((await jobs.items(user, preview.id, 1, 25)).job).toMatchObject({ state: 'failed', approvedAt: null });
    expect(await jobs.advance(user, preview.id)).toMatchObject({ state: 'previewing', processed: 10 });
    expect(await tags()).toEqual([]);
    expect(await jobs.advance(user, preview.id)).toMatchObject({ state: 'ready', processed: 11 });
    await jobs.apply(user, preview.id);
    const failedWrite = vi.spyOn(matching, 'sync').mockRejectedValueOnce(new Error('Temporary write failure'));
    try {
      await expect(jobs.advance(user, preview.id)).rejects.toThrow('Temporary write failure');
    } finally {
      failedWrite.mockRestore();
    }
    expect(await tags()).toEqual([]);
    expect(await jobs.advance(user, preview.id)).toMatchObject({ state: 'running', processed: 10, changed: 10 });
    expect(await jobs.advance(user, preview.id)).toMatchObject({ state: 'completed', processed: 11, changed: 11 });
    expect(await jobs.advance(user, preview.id)).toMatchObject({ state: 'completed', processed: 11 });
    expect((await tags()).map((t) => t.tagId)).toEqual([tagId]);
  }, 120000);
  it('rejects stale mapping previews and skips books changed after a valid preview', async () => {
    await sync([{ field: 'tags', value: 'remote' }]);
    await save('tags', 'remote', [{ field: 'tags', id: tagId }]);
    const jobs = module.get(TagMatchingJobsService);
    const stale = await jobs.create(user, []);
    await jobs.advance(user, stale.id);
    await save('tags', 'another', [{ field: 'tags', id: tagId }]);
    await expect(jobs.apply(user, stale.id)).rejects.toThrow('Matches changed');
    const preview = await jobs.create(user, []);
    await jobs.advance(user, preview.id);
    await db
      .update(s.bookMetadata)
      .set({ lockedFields: ['tags'] })
      .where(eq(s.bookMetadata.bookId, bookId));
    await jobs.apply(user, preview.id);
    expect(await jobs.advance(user, preview.id)).toMatchObject({ state: 'completed', skipped: 1, changed: 0 });
    expect(await tags()).toEqual([]);
  });
  it('shows protected fields and overrides only explicitly selected locks while retaining them', async () => {
    await sync([{ field: 'tags', value: 'remote' }]);
    await save('tags', 'remote', [{ field: 'tags', id: tagId }]);
    await db
      .update(s.bookMetadata)
      .set({ lockedFields: ['tags', 'genres'] })
      .where(eq(s.bookMetadata.bookId, bookId));
    const jobs = module.get(TagMatchingJobsService);
    const protectedPreview = await jobs.create(user, []);
    await jobs.advance(user, protectedPreview.id);
    const protectedPage = await jobs.items(user, protectedPreview.id, 1, 25);
    expect(protectedPage.items[0].change).toMatchObject({ addedTags: [], lockedFields: ['tags', 'genres'] });
    const overridePreview = await jobs.create(user, ['tags']);
    await jobs.advance(user, overridePreview.id);
    expect((await jobs.items(user, overridePreview.id, 1, 25)).items[0].change.addedTags).toEqual([tagName]);
    await jobs.apply(user, overridePreview.id);
    await jobs.advance(user, overridePreview.id);
    expect((await tags()).map((row) => row.tagId)).toEqual([tagId]);
    const [metadata] = await db.select({ locks: s.bookMetadata.lockedFields }).from(s.bookMetadata).where(eq(s.bookMetadata.bookId, bookId));
    expect(metadata.locks).toEqual(['tags', 'genres']);
  });
  it('backfills retained story evidence idempotently without applying it or guessing manual ownership', async () => {
    await db.update(s.users).set({ isSuperuser: true }).where(eq(s.users.id, user.id));
    await db.insert(s.bookTags).values({ bookId, tagId, managedOnly: false });
    const sourceId = randomUUID();
    await db.insert(s.fanfictionSources).values({
      id: sourceId,
      libraryId,
      createdBy: user.id,
      maintainerUserId: user.id,
      bookId,
      canonicalUrl: `https://example.test/${sourceId}`,
      canonicalKey: sourceId,
      site: 'example.test',
      title: 'Story',
      importOperationId: randomUUID(),
      relativePath: 'story.epub',
      state: 'active',
      categories: { fandoms: ['Unknown fandom'], characters: ['Named character'], relationships: [], warnings: [], rating: null },
    });
    expect(await backfillMatchingSnapshots(db, user.id, [libraryId], false)).toEqual({ examined: 1, inserted: 1 });
    expect(await db.select().from(s.tagMatchingSnapshots).where(eq(s.tagMatchingSnapshots.bookId, bookId))).toEqual([]);
    expect(await backfillMatchingSnapshots(db, user.id, [libraryId], true)).toEqual({ examined: 1, inserted: 1 });
    expect(await backfillMatchingSnapshots(db, user.id, [libraryId], true)).toEqual({ examined: 1, inserted: 0 });
    const [snapshot] = await db.select().from(s.tagMatchingSnapshots).where(eq(s.tagMatchingSnapshots.bookId, bookId));
    expect(snapshot.labels).toEqual([
      { field: 'fandoms', value: 'Unknown fandom' },
      { field: 'characters', value: 'Named character' },
    ]);
    expect(snapshot.version).toBe(0);
    expect(await tags()).toEqual([expect.objectContaining({ tagId, managedOnly: false })]);
    const jobs = module.get(TagMatchingJobsService);
    const preview = await jobs.create(user, []);
    await jobs.advance(user, preview.id);
    expect((await jobs.items(user, preview.id, 1, 25)).items[0].change).toMatchObject({ unresolved: 1, removedTags: [] });
  });
  it('seeds only the explicit account and retains subsequent edits on repeated deployment', async () => {
    await db.update(s.users).set({ isSuperuser: true }).where(eq(s.users.id, user.id));
    const seed = {
      schemaVersion: 1,
      rules: [{ source: '', field: 'tags', value: 'seed alias', action: 'match', targets: [{ field: 'tags', name: tagName }] }],
    };
    const preview = await importMatchingSeed(db, user.id, [libraryId], seed, false);
    expect(preview).toMatchObject({ applied: false, inserted: 1, retained: 0 });
    expect((await management.list(user, new MatchingPageDto())).total).toBe(0);
    const first = await importMatchingSeed(db, user.id, [libraryId], seed, true);
    expect(first).toMatchObject({ applied: true, inserted: 1, retained: 0 });
    await save('tags', 'seed alias', []);
    const version = (await management.own(user))!.version;
    const again = await importMatchingSeed(db, user.id, [libraryId], seed, true);
    expect(again).toMatchObject({ inserted: 0, retained: 1, version });
    await sync([{ field: 'tags', value: 'seed alias' }]);
    expect(await tags()).toEqual([]);
    expect((await management.review(user, new MatchingPageDto())).total).toBe(0);
  });
  it('rejects missing seed destinations without creating canonical labels or changing rules', async () => {
    const seed = {
      schemaVersion: 1,
      rules: [{ source: '', field: 'tags', value: 'seed alias', action: 'match', targets: [{ field: 'tags', name: `missing-${randomUUID()}` }] }],
    };
    await expect(importMatchingSeed(db, user.id, [libraryId], seed, true)).rejects.toThrow('superuser');
    await db.update(s.users).set({ isSuperuser: true }).where(eq(s.users.id, user.id));
    await expect(importMatchingSeed(db, user.id, [libraryId], seed, true)).rejects.toThrow('destination is missing');
    expect((await management.list(user, new MatchingPageDto())).total).toBe(0);
  });
  it('assigns a new library to the creator’s existing personal rulebook', async () => {
    const [library] = await db
      .insert(s.libraries)
      .values({ name: `new-${randomUUID()}` })
      .returning();
    try {
      await matching.assignNewLibrary(user, library.id);
      const own = await management.own(user);
      const [binding] = await db.select().from(s.libraryTagRulebooks).where(eq(s.libraryTagRulebooks.libraryId, library.id));
      expect(binding.rulebookId).toBe(own!.id);
      await expect(matching.assignNewLibrary({ ...user, active: false }, library.id)).rejects.toThrow('inactive');
    } finally {
      await db.delete(s.libraries).where(eq(s.libraries.id, library.id));
    }
  });
  it('holds unknown tags and genres while retaining raw evidence', async () => {
    await sync([
      { field: 'tags', value: 'Unknown' },
      { field: 'genres', value: 'Unknown genre' },
    ]);
    expect(await tags()).toEqual([]);
    expect(await genres()).toEqual([]);
    const review = await management.review(user, new MatchingPageDto());
    expect(review.total).toBe(2);
    const [snapshot] = await db.select().from(s.tagMatchingSnapshots).where(eq(s.tagMatchingSnapshots.bookId, bookId));
    expect(snapshot.labels).toHaveLength(2);
  });
  it('applies approved cross-field mappings and clears review without rewriting existing books', async () => {
    await sync([{ field: 'genres', value: 'Fandom' }]);
    await save('genres', 'Fandom', [{ field: 'tags', id: tagId }]);
    expect((await management.review(user, new MatchingPageDto())).total).toBe(0);
    expect(await tags()).toEqual([]);
    await sync([{ field: 'genres', value: 'Fandom' }]);
    expect((await tags()).map((t) => t.tagId)).toEqual([tagId]);
    expect(await genres()).toEqual([]);
  });
  it('retains manual assignments while replacing source-owned assignments', async () => {
    await db.insert(s.bookTags).values({ bookId, tagId });
    await save('genres', 'remote', [{ field: 'genres', id: genreId }]);
    await sync([{ field: 'genres', value: 'remote' }]);
    expect((await genres())[0].managedOnly).toBe(true);
    await sync([{ field: 'genres', value: 'unrecognized' }]);
    expect(await genres()).toEqual([]);
    expect((await tags())[0].tagId).toBe(tagId);
  });
  it('preserves tags and genres claimed by another source', async () => {
    await save('tags', 'remote', [
      { field: 'tags', id: tagId },
      { field: 'genres', id: genreId },
    ]);
    await sync([{ field: 'tags', value: 'remote' }], 'file:first');
    await sync([{ field: 'tags', value: 'remote' }], 'file:second');
    await sync([], 'file:first');
    expect(await tags()).toHaveLength(1);
    expect(await genres()).toHaveLength(1);
    await sync([], 'file:second');
    expect(await tags()).toEqual([]);
    expect(await genres()).toEqual([]);
  });
  it('keeps locks and records pending labels even when fields are protected', async () => {
    await db
      .update(s.bookMetadata)
      .set({ lockedFields: ['tags', 'genres'] })
      .where(eq(s.bookMetadata.bookId, bookId));
    await save('tags', 'remote', [
      { field: 'tags', id: tagId },
      { field: 'genres', id: genreId },
    ]);
    await sync([
      { field: 'tags', value: 'remote' },
      { field: 'tags', value: 'unknown' },
    ]);
    expect(await tags()).toEqual([]);
    expect(await genres()).toEqual([]);
    expect((await management.review(user, new MatchingPageDto())).total).toBe(1);
    const [meta] = await db.select().from(s.bookMetadata).where(eq(s.bookMetadata.bookId, bookId));
    expect(meta.lockedFields).toEqual(['tags', 'genres']);
  });
  it('does not restore manually excluded tags or genres', async () => {
    await save('tags', 'remote', [
      { field: 'tags', id: tagId },
      { field: 'genres', id: genreId },
    ]);
    await sync([{ field: 'tags', value: 'remote' }]);
    await db.transaction(async (tx) => {
      await matching.manualSelection(tx, bookId, 'tags', [], user.id);
      await matching.manualSelection(tx, bookId, 'genres', [], user.id);
      await tx.delete(s.bookTags).where(eq(s.bookTags.bookId, bookId));
      await tx.delete(s.bookGenres).where(eq(s.bookGenres.bookId, bookId));
    });
    await sync([{ field: 'tags', value: 'remote' }]);
    expect(await tags()).toEqual([]);
    expect(await genres()).toEqual([]);
  });
  it('makes a deleted specific target unresolved rather than falling through to a general rule', async () => {
    await save('tags', 'remote', [{ field: 'genres', id: genreId }]);
    await save('tags', 'remote', [{ field: 'tags', id: tagId }], 'file');
    await db.delete(s.tags).where(eq(s.tags.id, tagId));
    await sync([{ field: 'tags', value: 'remote' }]);
    expect(await genres()).toEqual([]);
    expect((await management.review(user, new MatchingPageDto())).total).toBe(1);
  });
  it.each(['tags', 'genres'] as const)('remembers manual %s removal through the entity manager', async (field) => {
    const id = field === 'tags' ? tagId : genreId;
    const strategy = field === 'tags' ? module.get(TagStrategy) : module.get(GenreStrategy);
    await save(field, 'remote', [{ field, id }]);
    await sync([{ field, value: 'remote' }]);
    await strategy.deleteEntity({ entityId: id, mode: 'soft', libraryIds: [libraryId], userId: user.id });
    await sync([{ field, value: 'remote' }]);
    expect(field === 'tags' ? await tags() : await genres()).toEqual([]);
    expect((await management.review(user, new MatchingPageDto())).total).toBe(0);
  });
  it('refuses canonical mutations that would change another account’s matches', async () => {
    const [other] = await db
      .insert(s.users)
      .values({ username: `foreign-${randomUUID()}`, name: 'Other', passwordHash: 'unused' })
      .returning();
    try {
      const [rulebook] = await db.insert(s.tagRulebooks).values({ userId: other.id }).returning();
      const [rule] = await db
        .insert(s.tagMatchingRules)
        .values({ rulebookId: rulebook.id, field: 'tags', value: 'foreign', key: 'foreign', action: 'match' })
        .returning();
      await db.insert(s.tagMatchingTargets).values({ ruleId: rule.id, tagId });
      await expect(
        module.get(TagStrategy).rename({ entityId: tagId, newName: 'not allowed', userId: user.id, libraryIds: [libraryId] }),
      ).rejects.toThrow('another matching database');
      const [tag] = await db.select().from(s.tags).where(eq(s.tags.id, tagId));
      expect(tag.name).toBe(tagName);
    } finally {
      await db.delete(s.users).where(eq(s.users.id, other.id));
    }
  });
  it.each(['tags', 'genres'] as const)('learns %s rename aliases and keeps deleted targets unresolved', async (field) => {
    const id = field === 'tags' ? tagId : genreId;
    const name = field === 'tags' ? tagName : genreName;
    const strategy = field === 'tags' ? module.get(TagStrategy) : module.get(GenreStrategy);
    await save(field, 'remote', [{ field, id }]);
    await sync([{ field, value: 'remote' }]);
    const version = (await management.own(user))!.version;
    await strategy.rename({ entityId: id, newName: `${name}-renamed`, userId: user.id, libraryIds: [libraryId] });
    await sync([{ field, value: name }]);
    expect((await management.own(user))!.version).toBe(version + 1);
    expect(field === 'tags' ? (await tags()).map((row) => row.tagId) : (await genres()).map((row) => row.genreId)).toEqual([id]);
    await strategy.deleteEntity({ entityId: id, mode: 'hard', libraryIds: [libraryId], userId: user.id });
    await sync([{ field, value: name }]);
    expect((await management.review(user, new MatchingPageDto())).total).toBe(1);
    expect(field === 'tags' ? await tags() : await genres()).toEqual([]);
  });
  it.each(['tags', 'genres'] as const)('retargets %s mappings and imported ownership during merges', async (field) => {
    const table = field === 'tags' ? s.tags : s.genres;
    const targetId = field === 'tags' ? tagId : genreId;
    const strategy = field === 'tags' ? module.get(TagStrategy) : module.get(GenreStrategy);
    const [source] = await db
      .insert(table)
      .values({ name: `merge-${randomUUID()}` })
      .returning();
    try {
      await save(field, 'remote', [{ field, id: source.id }]);
      await sync([{ field, value: 'remote' }]);
      await strategy.merge({ targetId, sourceIds: [source.id], userId: user.id, libraryIds: [libraryId] });
      const links = field === 'tags' ? await tags() : await genres();
      expect(links).toHaveLength(1);
      expect(links[0].managedOnly).toBe(true);
      await sync([{ field, value: source.name }]);
      expect(field === 'tags' ? (await tags()).map((row) => row.tagId) : (await genres()).map((row) => row.genreId)).toEqual([targetId]);
      await sync([]);
      expect(field === 'tags' ? await tags() : await genres()).toEqual([]);
    } finally {
      await db.delete(table).where(eq(table.id, source.id));
    }
  });
  it('remembers approved destinations for EPUB subject reimport without overriding explicit file ignores', async () => {
    await save('tags', 'remote', [
      { field: 'tags', id: tagId },
      { field: 'genres', id: genreId },
    ]);
    await sync([
      { field: 'genres', value: tagName },
      { field: 'genres', value: genreName },
    ]);
    expect((await tags()).map((row) => row.tagId)).toEqual([tagId]);
    expect((await genres()).map((row) => row.genreId)).toEqual([genreId]);
    await save('genres', tagName, [], 'file');
    await save('tags', 'another alias', [{ field: 'tags', id: tagId }]);
    await sync([{ field: 'genres', value: tagName }]);
    expect(await tags()).toEqual([]);
  });
  it('rejects stale or unversioned publication after a mapping changes', async () => {
    await db.transaction((tx) => matching.assertCurrentVersion(tx, libraryId, 1));
    await save('tags', 'incoming', [{ field: 'tags', id: tagId }]);
    await expect(db.transaction((tx) => matching.assertCurrentVersion(tx, libraryId, 1))).rejects.toThrow('Tag matches changed');
    await expect(db.transaction((tx) => matching.assertCurrentVersion(tx, libraryId, undefined))).rejects.toThrow('Tag matches changed');
    await db.transaction((tx) => matching.assertCurrentVersion(tx, libraryId, 2));
  });
  it('preserves omitted source fields but clears explicitly empty fields', async () => {
    await save('tags', 'old tag', [{ field: 'tags', id: tagId }]);
    await save('genres', 'old genre', [{ field: 'genres', id: genreId }]);
    await sync([
      { field: 'tags', value: 'old tag' },
      { field: 'genres', value: 'old genre' },
    ]);
    await matching.importLabels(bookId, { source: 'file', sourceKey: 'file:metadata', labels: [], preserveFields: ['tags'] });
    expect((await tags()).map((row) => row.tagId)).toEqual([tagId]);
    expect(await genres()).toEqual([]);
    const [snapshot] = await db.select().from(s.tagMatchingSnapshots).where(eq(s.tagMatchingSnapshots.bookId, bookId));
    expect(snapshot.labels).toEqual([{ field: 'tags', value: 'old tag' }]);
    await sync([]);
    expect(await tags()).toEqual([]);
  });
  it('records ignored labels without presenting them as matches or review items', async () => {
    await save('tags', 'ignored', []);
    await sync([{ field: 'tags', value: 'ignored' }]);
    const observations = await db.select().from(s.tagMatchingObservations).where(eq(s.tagMatchingObservations.bookId, bookId));
    expect(observations.map((row) => row.status)).toEqual(['ignored']);
    expect((await management.review(user, new MatchingPageDto())).total).toBe(0);
    expect(await tags()).toEqual([]);
  });
  it('edits a rule in place without leaving the previous alias and rejects collisions', async () => {
    const first = await save('tags', 'old', [{ field: 'tags', id: tagId }]);
    const edited = await management.save(user, {
      id: first.id,
      version: first.version,
      source: 'file',
      field: 'genres',
      value: 'new',
      action: 'match',
      targets: [{ field: 'tags', id: tagId }],
    });
    expect(edited.id).toBe(first.id);
    await sync([
      { field: 'tags', value: 'old' },
      { field: 'genres', value: 'new' },
    ]);
    expect((await tags()).map((row) => row.tagId)).toEqual([tagId]);
    expect((await management.review(user, new MatchingPageDto())).items.map((row) => row.value)).toEqual(['old']);
    const other = await save('genres', 'taken', [], 'file');
    await expect(
      management.save(user, { id: first.id, version: other.version, source: 'file', field: 'genres', value: 'taken', action: 'ignore', targets: [] }),
    ).rejects.toThrow('already exists');
    await expect(
      management.save(user, { id: randomUUID(), version: other.version, source: '', field: 'tags', value: 'unknown', action: 'ignore', targets: [] }),
    ).rejects.toThrow('not available');
  });
  it('rejects stale edits and changes against another account’s rule', async () => {
    const result = await save('tags', 'remote', [{ field: 'tags', id: tagId }]);
    await expect(management.save(user, { version: 1, source: '', field: 'tags', value: 'remote', action: 'ignore', targets: [] })).rejects.toThrow(
      'Matches changed',
    );
    await expect(management.remove({ ...user, id: user.id + 100000 }, result.id, result.version)).rejects.toThrow('not available');
  });
  it('does not expose character and named pairing noise in the review queue', async () => {
    await sync([
      { field: 'characters', value: 'Alice' },
      { field: 'genres', value: 'Alice' },
      { field: 'relationships', value: 'Alice/Bob' },
      { field: 'tags', value: 'Alice/Bob' },
      { field: 'fandoms', value: 'Unknown fandom' },
    ]);
    const review = await management.review(user, new MatchingPageDto());
    expect(review.items.map((i) => i.value)).toEqual(['Unknown fandom']);
  });
  it('deduplicates repeated observations and imported assignments on retries', async () => {
    await save('tags', 'remote', [{ field: 'tags', id: tagId }]);
    const labels: IncomingLabel[] = [
      { field: 'tags', value: 'REMOTE' },
      { field: 'tags', value: ' remote ' },
    ];
    await sync(labels);
    await sync(labels);
    expect(await tags()).toHaveLength(1);
    expect(await db.select().from(s.tagMatchingObservations).where(eq(s.tagMatchingObservations.bookId, bookId))).toHaveLength(1);
  });
});

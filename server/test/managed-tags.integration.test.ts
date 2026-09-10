import { ManagedMetadataService } from '../src/modules/metadata/managed-metadata.service';
import { BookMetadataLockRepository } from '../src/modules/book-metadata-lock/book-metadata-lock.repository';
import { RevisionCatalogService } from '../src/modules/book-revision/revision-catalog.service';
import { RevisionCoordinationService } from '../src/modules/book-revision/revision-coordination.service';
import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from '../src/db';
import * as schema from '../src/db/schema';
import { ManagedTagService } from '../src/modules/metadata/managed-tag.service';
import { MetadataService } from '../src/modules/metadata/metadata.service';
import { MetadataExtractionService } from '../src/modules/metadata/metadata-extraction.service';
import { MetadataScoreService } from '../src/modules/metadata-score/metadata-score.service';
import { NarratorService } from '../src/modules/narrator/narrator.service';
import { ComicMetadataRepository } from '../src/modules/metadata/comic-metadata.repository';
import { BookMetadataLockService } from '../src/modules/book-metadata-lock/book-metadata-lock.service';

const configPath = process.env.REVISION_TEST_DB_CONFIG;
describe.skipIf(!configPath)('managed story metadata with PostgreSQL', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let module: TestingModule;
  let service: ManagedTagService;
  let metadata: MetadataService;
  let libraryId: number;
  let bookId: number;
  const source = (key = 'fanfiction:first') => ({ key, libraryId });
  const sync = (names: string[], key?: string) => db.transaction((tx) => service.sync(tx, bookId, source(key), names));
  const links = () =>
    db
      .select({ name: schema.tags.name, managedOnly: schema.bookTags.managedOnly })
      .from(schema.bookTags)
      .innerJoin(schema.tags, eq(schema.tags.id, schema.bookTags.tagId))
      .where(eq(schema.bookTags.bookId, bookId))
      .orderBy(asc(schema.tags.name));
  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (config.database !== 'bookorbit_revision_validation' && !/^bookorbit_ux_(fresh|upgrade)_20260910$/.test(config.database ?? ''))
      throw new Error('An isolated validation database is required');
    pool = new Pool({ ...config, application_name: 'bookorbit_managed_tags_test', statement_timeout: 10_000 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../src/db/migrations') });
    module = await Test.createTestingModule({
      providers: [
        ManagedTagService,
        ManagedMetadataService,
        BookMetadataLockService,
        BookMetadataLockRepository,
        RevisionCatalogService,
        RevisionCoordinationService,
        MetadataService,
        { provide: DB, useValue: db },
        { provide: ConfigService, useValue: { get: () => '/unused-managed-tags-test' } },
        ...[MetadataExtractionService, MetadataScoreService, NarratorService, ComicMetadataRepository].map((provide) => ({
          provide,
          useValue: {},
        })),
      ],
    }).compile();
    service = module.get(ManagedTagService);
    metadata = module.get(MetadataService);
  }, 60_000);
  beforeEach(async () => {
    const [library] = await db
      .insert(schema.libraries)
      .values({ name: `managed-tags-${randomUUID()}` })
      .returning();
    libraryId = library.id;
    const [folder] = await db
      .insert(schema.libraryFolders)
      .values({ libraryId, path: `/validation/${randomUUID()}` })
      .returning();
    const [book] = await db
      .insert(schema.books)
      .values({ libraryId, libraryFolderId: folder.id, folderPath: `/validation/${randomUUID()}` })
      .returning();
    bookId = book.id;
    await db.insert(schema.bookMetadata).values({ bookId, title: 'Managed story' });
  });
  afterEach(async () => {
    await db.delete(schema.libraries).where(eq(schema.libraries.id, libraryId));
  });
  afterAll(async () => {
    await module?.close();
    await pool?.end();
  });

  it('refreshes unlocked metadata without changing custom covers or unrelated fields', async () => {
    const managed = module.get(ManagedMetadataService);
    await db
      .update(schema.bookMetadata)
      .set({ title: 'Locked title', description: 'Old description', coverSource: 'custom', publisher: 'Manual publisher', lockedFields: ['title'] })
      .where(eq(schema.bookMetadata.bookId, bookId));
    await metadata.replaceTags(bookId, ['Manual tag']);
    const preview = { title: 'Source title', description: 'Updated description', authors: ['Story writer'], tags: ['Source tag'] };
    expect(await db.transaction((tx) => managed.apply(tx, bookId, source(), preview))).toBe(true);
    const [saved] = await db.select().from(schema.bookMetadata).where(eq(schema.bookMetadata.bookId, bookId));
    expect(saved).toMatchObject({ title: 'Locked title', description: 'Updated description', coverSource: 'custom', publisher: 'Manual publisher' });
    const writers = await db
      .select({ name: schema.authors.name })
      .from(schema.bookAuthors)
      .innerJoin(schema.authors, eq(schema.authors.id, schema.bookAuthors.authorId))
      .where(eq(schema.bookAuthors.bookId, bookId));
    expect(writers).toEqual([{ name: 'Story writer' }]);
    expect(await links()).toEqual([
      { name: 'Manual tag', managedOnly: false },
      { name: 'Source tag', managedOnly: true },
    ]);
    const [before] = await db.select({ updatedAt: schema.books.updatedAt }).from(schema.books).where(eq(schema.books.id, bookId));
    expect(await db.transaction((tx) => managed.apply(tx, bookId, source(), preview))).toBe(false);
    const [after] = await db.select({ updatedAt: schema.books.updatedAt }).from(schema.books).where(eq(schema.books.id, bookId));
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('uses transaction-local automated field locks and rejects another library', async () => {
    const managed = module.get(ManagedMetadataService);
    await metadata.replaceAuthors(bookId, [{ name: 'Manual writer', sortName: null }], { emitEvent: false });
    const preview = { title: 'Source title', description: 'Source description', authors: ['Other writer'], tags: ['Source tag'] };
    await db.transaction(async (tx) => {
      await module.get(BookMetadataLockRepository).replaceLockedFields(bookId, ['title', 'description', 'authors', 'tags'], tx);
      expect(await managed.apply(tx, bookId, source(), preview)).toBe(false);
    });
    expect(await links()).toEqual([]);
    const writers = await db
      .select({ name: schema.authors.name })
      .from(schema.bookAuthors)
      .innerJoin(schema.authors, eq(schema.authors.id, schema.bookAuthors.authorId))
      .where(eq(schema.bookAuthors.bookId, bookId));
    expect(writers).toEqual([{ name: 'Manual writer' }]);
    await expect(db.transaction((tx) => managed.apply(tx, bookId, { ...source(), libraryId: libraryId + 9999 }, preview))).rejects.toThrow(
      'this library',
    );
  });

  it('fences metadata completion against the installed revision and library', async () => {
    const catalog = module.get(RevisionCatalogService);
    const managed = module.get(ManagedMetadataService);
    const [book] = await db.select().from(schema.books).where(eq(schema.books.id, bookId));
    const [file] = await db
      .insert(schema.bookFiles)
      .values({ bookId, libraryFolderId: book.libraryFolderId, absolutePath: `/validation/${randomUUID()}.epub`, format: 'epub', ino: 1 })
      .returning();
    const [revision] = await db
      .insert(schema.bookFileRevisions)
      .values({ bookFileId: file.id, sha256: 'a'.repeat(64), fileHash: 'b'.repeat(32), sizeBytes: 100, reason: 'baseline', changeKind: 'baseline' })
      .returning();
    await db.update(schema.bookFiles).set({ currentRevisionId: revision.id }).where(eq(schema.bookFiles.id, file.id));
    const preview = { title: 'Stale title', description: '', authors: [], tags: [] };
    await expect(
      db.transaction(async (tx) => {
        await catalog.lockCurrent(tx, file.id, libraryId, randomUUID());
        await managed.apply(tx, bookId, source(), preview);
      }),
    ).rejects.toThrow('installed revision changed');
    expect((await db.select().from(schema.bookMetadata).where(eq(schema.bookMetadata.bookId, bookId)))[0].title).toBe('Managed story');
    await expect(db.transaction((tx) => catalog.lockCurrent(tx, file.id, libraryId + 9999, revision.id))).rejects.toThrow(
      'installed revision changed',
    );
    expect(await db.transaction((tx) => catalog.lockCurrent(tx, file.id, libraryId, revision.id))).toEqual({ bookId, revisionId: revision.id });
  });

  it('removes obsolete source tags while preserving manual tags and other source claims', async () => {
    await metadata.replaceTags(bookId, ['Manual', 'Shared']);
    await sync(['Shared', 'First']);
    await sync(['Shared', 'Second'], 'fanfiction:second');
    await sync([]);
    expect(await links()).toEqual([
      { name: 'Manual', managedOnly: false },
      { name: 'Second', managedOnly: true },
      { name: 'Shared', managedOnly: false },
    ]);
    await db.transaction((tx) => service.release(tx, bookId, source('fanfiction:second')));
    await sync([]);
    expect((await links()).every((row) => !row.managedOnly)).toBe(true);
    expect(await db.select().from(schema.bookTagSources).where(eq(schema.bookTagSources.bookId, bookId))).toEqual([]);
  });

  it('preserves source ownership of unchanged tags when manual tags are edited', async () => {
    await sync(['Keep', 'Remove']);
    await metadata.replaceTags(bookId, ['Keep', 'My tag']);
    expect(await links()).toEqual([
      { name: 'Keep', managedOnly: true },
      { name: 'My tag', managedOnly: false },
    ]);
    await sync([]);
    expect(await links()).toEqual([{ name: 'My tag', managedOnly: false }]);
  });

  it('honors tag locks and enforces current library scope', async () => {
    await sync(['Original']);
    await db
      .update(schema.bookMetadata)
      .set({ lockedFields: ['tags'] })
      .where(eq(schema.bookMetadata.bookId, bookId));
    await sync(['Replacement']);
    expect(await links()).toEqual([{ name: 'Original', managedOnly: true }]);
    await expect(db.transaction((tx) => service.sync(tx, bookId, { ...source(), libraryId: libraryId + 9999 }, []))).rejects.toThrow('this library');
  });

  it('serializes manual replacement after source publication without leaving newly inserted tags behind', async () => {
    await sync(['Original']);
    const locked = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const publication = db.transaction(async (tx) => {
      await tx.execute(sql`select book_id from ${schema.bookMetadata} where book_id = ${bookId} for update`);
      locked.resolve();
      await resume.promise;
      await service.sync(tx, bookId, source(), ['New source tag']);
    });
    await locked.promise;
    const manual = metadata.replaceTags(bookId, ['My final choice']);
    try {
      await vi.waitFor(async () => {
        const waiting = await pool.query(
          "select 1 from pg_stat_activity where application_name = 'bookorbit_managed_tags_test' and wait_event_type = 'Lock'",
        );
        expect(waiting.rowCount).toBeGreaterThan(0);
      });
    } finally {
      resume.resolve();
      await Promise.all([publication, manual]);
    }
    expect(await links()).toEqual([{ name: 'My final choice', managedOnly: false }]);
  });

  it('bounds source tags and rolls back ownership with the surrounding operation', async () => {
    const names = Array.from({ length: 1000 }, (_, index) => `bounded-${index}`);
    await sync(names);
    expect(await links()).toHaveLength(1000);
    await expect(sync([...names, 'overflow'])).rejects.toThrow('limits');
    await expect(
      db.transaction(async (tx) => {
        await service.sync(tx, bookId, source(), []);
        throw new Error('Interrupted publication');
      }),
    ).rejects.toThrow('Interrupted');
    const claims = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.bookTagSources)
      .where(and(eq(schema.bookTagSources.bookId, bookId), eq(schema.bookTagSources.sourceKey, source().key)));
    expect(claims[0].count).toBe(1000);
  });
  it('keeps explicitly entered personal tags when source tags change', async () => {
    await sync(['Source', 'Personal, with comma']);
    await db.transaction((tx) => service.keepPersonal(tx, bookId, source(), ['Personal, with comma']));
    await sync(['Next source']);
    expect(await links()).toEqual([
      { name: 'Next source', managedOnly: true },
      { name: 'Personal, with comma', managedOnly: false },
    ]);
  });
  it('persists genres while honoring the existing metadata lock', async () => {
    const managed = module.get(ManagedMetadataService);
    const preview = { title: 'Story', description: '', authors: [], tags: [], genres: ['Fantasy'] };
    await db.transaction((tx) => managed.apply(tx, bookId, source(), preview));
    expect((await db.transaction((tx) => managed.snapshot(tx, bookId, libraryId, source().key))).current.genres).toEqual(['Fantasy']);
    await db
      .update(schema.bookMetadata)
      .set({ lockedFields: ['genres'] })
      .where(eq(schema.bookMetadata.bookId, bookId));
    await db.transaction((tx) => managed.apply(tx, bookId, source(), { ...preview, genres: ['Romance'] }));
    expect((await db.transaction((tx) => managed.snapshot(tx, bookId, libraryId, source().key))).current.genres).toEqual(['Fantasy']);
  });
});

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
describe.skipIf(!configPath)('managed tag ownership with PostgreSQL', () => {
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
    if (config.database !== 'bookorbit_revision_validation') throw new Error('An isolated validation database is required');
    pool = new Pool({ ...config, application_name: 'bookorbit_managed_tags_test', statement_timeout: 10_000 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../src/db/migrations') });
    module = await Test.createTestingModule({
      providers: [
        ManagedTagService,
        MetadataService,
        { provide: DB, useValue: db },
        { provide: ConfigService, useValue: { get: () => '/unused-managed-tags-test' } },
        ...[MetadataExtractionService, MetadataScoreService, NarratorService, ComicMetadataRepository, BookMetadataLockService].map((provide) => ({
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
});

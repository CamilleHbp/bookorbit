import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { ReadingAnchorDto } from '../src/modules/book-revision/dto/reading-anchor.dto';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReadingAnchor } from '@bookorbit/types';
import { DB } from '../src/db';
import * as schema from '../src/db/schema';
import { CanonicalReadingService, resetCanonicalReadingEvents } from '../src/modules/book-revision/canonical-reading.service';
import { BookRepository } from '../src/modules/book/book.repository';

const configPath = process.env.REVISION_TEST_DB_CONFIG;
describe.skipIf(!configPath)('canonical reading events with PostgreSQL', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let service: CanonicalReadingService;
  let libraryId: number;
  let bookId: number;
  let fileId: number;
  let userIds: number[];
  const revision = `sha256:${'a'.repeat(64)}`;

  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (config.database !== 'bookorbit_revision_validation') throw new Error('An isolated revision validation database is required');
    pool = new Pool(config);
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../src/db/migrations') });
    const module = await Test.createTestingModule({ providers: [CanonicalReadingService, { provide: DB, useValue: db }] }).compile();
    service = module.get(CanonicalReadingService);
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    const [library] = await db
      .insert(schema.libraries)
      .values({ name: `events-test-${randomUUID()}` })
      .returning();
    libraryId = library.id;
    const path = `/revision-events-test/${randomUUID()}`;
    const [folder] = await db.insert(schema.libraryFolders).values({ libraryId, path }).returning();
    const [book] = await db.insert(schema.books).values({ libraryId, libraryFolderId: folder.id, folderPath: path }).returning();
    bookId = book.id;
    const [file] = await db
      .insert(schema.bookFiles)
      .values({ bookId, libraryFolderId: folder.id, absolutePath: `${path}/story.epub`, format: 'epub', ino: '1' })
      .returning();
    fileId = file.id;
    userIds = (
      await db
        .insert(schema.users)
        .values([1, 2].map(() => ({ username: `events-${randomUUID()}`, name: 'Event test', passwordHash: 'not-a-login-hash' })))
        .returning({ id: schema.users.id })
    ).map((row) => row.id);
  });
  afterEach(async () => {
    await db.delete(schema.libraries).where(eq(schema.libraries.id, libraryId));
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  });
  function anchor(sequence = 1, deviceId = 'reader'): ReadingAnchor {
    return {
      schemaVersion: 1,
      bookId,
      bookFileId: fileId,
      revision,
      provisionalSha256: 'a'.repeat(64),
      chapterIndex: 1,
      chapterFraction: 0.5,
      bookFraction: 0.3,
      quote: 'The original passage',
      nativeLocator: { kind: 'xpointer', value: '/body/p[1]' },
      event: { id: randomUUID(), deviceId, deviceSequence: sequence, occurredAt: '2026-09-05T10:00:00.000Z', resetGeneration: 0 },
    };
  }
  const record = (value: ReadingAnchor, userId = userIds[0]) => service.record(userId, fileId, libraryId, value);

  it('deduplicates retries and refuses to mutate an existing event', async () => {
    const value = anchor();
    expect((await record(value)).outcome).toBe('accepted');
    expect((await record(plainToInstance(ReadingAnchorDto, value))).outcome).toBe('duplicate');
    await expect(record({ ...value, bookFraction: 0.9 })).rejects.toThrow('reused');
    expect(await db.select().from(schema.canonicalReadingEvents).where(eq(schema.canonicalReadingEvents.bookFileId, fileId))).toHaveLength(1);
  });

  it('uses sequence over clock skew and never treats a larger percentage as newer', async () => {
    const first = anchor();
    await record(first);
    const newer = anchor(2);
    newer.event!.occurredAt = '2026-09-04T10:00:00.000Z';
    newer.bookFraction = 0.1;
    expect((await record(newer)).outcome).toBe('accepted');
    const stale = anchor(1);
    stale.event!.occurredAt = '2026-09-06T10:00:00.000Z';
    stale.bookFraction = 0.99;
    expect((await record(stale)).outcome).toBe('superseded');
    expect((await service.state(userIds[0], fileId, libraryId)).anchor).toEqual(newer);
  });

  it('serializes concurrent workers and retains the highest device sequence', async () => {
    const values = [anchor(1), anchor(3), anchor(2)];
    await Promise.all(values.map((value) => record(value)));
    expect((await service.state(userIds[0], fileId, libraryId)).anchor?.event?.deviceSequence).toBe(3);
  });

  it('keeps cross-device arrival order out of event recency', async () => {
    const latest = anchor(1, 'newer-device');
    await record(latest);
    const delayed = anchor(50, 'offline-device');
    delayed.event!.occurredAt = '2026-09-01T10:00:00.000Z';
    expect((await record(delayed)).outcome).toBe('superseded');
    expect((await service.state(userIds[0], fileId, libraryId)).anchor).toEqual(latest);
  });

  it('advances the generation in the existing reset transaction and holds stale reconnects', async () => {
    const original = anchor();
    await record(original);
    await new BookRepository(db).clearFileProgress(userIds[0], fileId);
    expect(await service.state(userIds[0], fileId, libraryId)).toEqual({ resetGeneration: 1, anchor: null });
    expect((await record(original)).outcome).toBe('reset_required');
    const afterReset = anchor();
    afterReset.event!.resetGeneration = 1;
    expect((await record(afterReset)).outcome).toBe('accepted');
    await expect(
      db.transaction(async (tx) => {
        await resetCanonicalReadingEvents(tx, userIds[0], [fileId]);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await service.state(userIds[0], fileId, libraryId)).resetGeneration).toBe(1);
  });

  it('keeps separate copies and acknowledgements without replacing the richer canonical anchor', async () => {
    const value = anchor();
    await record(value);
    const acknowledgement = {
      eventId: value.event!.id,
      revision,
      nativeLocator: { kind: 'xpointer' as const, value: '/body/p[2]' },
      quality: 'approximate' as const,
    };
    for (const copy of [randomUUID(), randomUUID()]) await service.acknowledge(userIds[0], fileId, libraryId, 'reader', copy, acknowledgement);
    expect(
      await db.select().from(schema.readingPositionAcknowledgements).where(eq(schema.readingPositionAcknowledgements.bookFileId, fileId)),
    ).toHaveLength(2);
    expect((await service.state(userIds[0], fileId, libraryId)).anchor).toEqual(value);
    expect(await db.select().from(schema.readingProgress).where(eq(schema.readingProgress.bookFileId, fileId))).toHaveLength(0);
    await record(anchor(2));
    await expect(service.acknowledge(userIds[0], fileId, libraryId, 'reader', randomUUID(), acknowledgement)).rejects.toThrow('changed');
  });

  it('scopes events to the current user, file and library', async () => {
    const value = anchor();
    await record(value);
    expect((await service.state(userIds[1], fileId, libraryId)).anchor).toBeNull();
    await expect(service.state(userIds[0], fileId, libraryId + 1)).rejects.toThrow('not found');
    await expect(record({ ...value, bookId: bookId + 1 })).rejects.toThrow('identity');
    await expect(record({ ...value, revision: randomUUID() })).rejects.toThrow('Revision not found');
    await expect(
      service.acknowledge(userIds[1], fileId, libraryId, 'reader', randomUUID(), {
        eventId: value.event!.id,
        revision,
        nativeLocator: { kind: 'xpointer', value: '/body' },
        quality: 'exact',
      }),
    ).rejects.toThrow('changed');
  });
});

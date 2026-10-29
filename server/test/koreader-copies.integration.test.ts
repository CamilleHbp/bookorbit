import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_CONTENT_FILTER_RULES, Permission } from '@bookorbit/types';
import { DB } from '../src/db';
import * as schema from '../src/db/schema';
import type { RequestUser } from '../src/common/types/request-user';
import { PermissionService } from '../src/common/services/permission.service';
import { BookReadService } from '../src/modules/book/book-read.service';
import { BookRepository } from '../src/modules/book/book.repository';
import { RevisionCatalogService } from '../src/modules/book-revision/revision-catalog.service';
import { RevisionCoordinationService } from '../src/modules/book-revision/revision-coordination.service';
import { KoreaderCopyService } from '../src/modules/koreader/koreader-copy.service';
import type { KoreaderCopyInventoryDto } from '../src/modules/koreader/dto/koreader-copy.dto';

const configPath = process.env.REVISION_TEST_DB_CONFIG;
describe.skipIf(!configPath)('KOReader installed copy inventory', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let module: TestingModule;
  let service: KoreaderCopyService;
  let users: RequestUser[];
  let libraryIds: number[];
  let file: typeof schema.bookFiles.$inferSelect;
  let revision: typeof schema.bookFileRevisions.$inferSelect;
  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (config.database !== 'bookorbit_revision_validation') throw new Error('Isolated validation database required');
    pool = new Pool({ ...config, connectionTimeoutMillis: 10_000, statement_timeout: 20_000 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../src/db/migrations') });
    users = (
      await db
        .insert(schema.users)
        .values([0, 1].map(() => ({ username: `copy-${randomUUID()}`, name: 'Copy test', passwordHash: 'not-a-login-hash' })))
        .returning()
    ).map(
      (user) =>
        ({ ...user, permissions: [Permission.KoreaderSync, Permission.LibraryDownload], contentFilters: EMPTY_CONTENT_FILTER_RULES }) as RequestUser,
    );
    module = await Test.createTestingModule({
      providers: [
        KoreaderCopyService,
        BookReadService,
        BookRepository,
        RevisionCatalogService,
        RevisionCoordinationService,
        PermissionService,
        { provide: DB, useValue: db },
      ],
    }).compile();
    service = module.get(KoreaderCopyService);
  }, 60_000);
  beforeEach(async () => {
    libraryIds = (
      await db
        .insert(schema.libraries)
        .values([0, 1].map(() => ({ name: `copy-${randomUUID()}` })))
        .returning()
    ).map((library) => library.id);
    const [folder] = await db
      .insert(schema.libraryFolders)
      .values({ libraryId: libraryIds[0], path: `/validation/${libraryIds[0]}` })
      .returning();
    const [book] = await db
      .insert(schema.books)
      .values({ libraryId: libraryIds[0], libraryFolderId: folder.id, folderPath: folder.path })
      .returning();
    [file] = await db
      .insert(schema.bookFiles)
      .values({
        bookId: book.id,
        libraryFolderId: folder.id,
        absolutePath: `${folder.path}/story.epub`,
        ino: 1,
        format: 'epub',
        sha256: 'a'.repeat(64),
        sizeBytes: 100,
      })
      .returning();
    [revision] = await db
      .insert(schema.bookFileRevisions)
      .values({ bookFileId: file.id, sha256: file.sha256!, fileHash: '1'.repeat(32), sizeBytes: 100, reason: 'baseline' })
      .returning();
    await db.update(schema.bookFiles).set({ currentRevisionId: revision.id }).where(eq(schema.bookFiles.id, file.id));
    await db
      .insert(schema.userLibraryAccess)
      .values(users.map((user) => ({ userId: user.id, libraryId: libraryIds[0], accessLevel: 'viewer' as const })));
  });
  afterEach(async () => {
    await db.delete(schema.libraries).where(inArray(schema.libraries.id, libraryIds));
    await db.delete(schema.koreaderDeliveryDevices).where(
      inArray(
        schema.koreaderDeliveryDevices.userId,
        users.map((user) => user.id),
      ),
    );
  });
  afterAll(async () => {
    await module?.close();
    if (users)
      await db.delete(schema.users).where(
        inArray(
          schema.users.id,
          users.map((user) => user.id),
        ),
      );
    await pool?.end();
  });
  const report = (overrides: Partial<KoreaderCopyInventoryDto> = {}): KoreaderCopyInventoryDto => ({
    protocolVersion: 1,
    deviceId: 'reader',
    sequence: 1,
    pluginVersion: '1.5.2',
    deliveryCapabilityVersion: 0,
    positionCapabilityVersion: 0,
    copies: [{ copyId: randomUUID(), bookFileId: file.id, pathname: '/books/story.epub', sha256: file.sha256!, sizeBytes: 100 }],
    ...overrides,
  });
  const list = (user = users[0]) => service.list({ limit: 100 }, user);
  it('keeps multiple copies and user namespaces independent, defaulting to Notify', async () => {
    const input = report();
    input.copies.push({ ...input.copies[0], copyId: randomUUID(), pathname: '/backup/story.epub' });
    const saved = await service.report(input, users[0]);
    expect(saved.copies.map((copy) => copy.status)).toEqual(['accepted', 'accepted']);
    expect(new Set(saved.copies.map((copy) => copy.id)).size).toBe(2);
    expect((await list()).items.map((copy) => copy.policy)).toEqual(['notify', 'notify']);
    expect((await list()).items.every((copy) => copy.identity === 'known' && copy.revisionId === revision.id)).toBe(true);
    await service.report(input, users[1]);
    expect((await list(users[1])).items).toHaveLength(2);
    expect((await list()).items).toHaveLength(2);
  });
  it('deduplicates reports and rejects stale sequence changes without losing the new pathname', async () => {
    const input = report();
    await service.report(input, users[0]);
    expect((await service.report(input, users[0])).copies[0].status).toBe('unchanged');
    const changed = { ...input, sequence: 2, copies: [{ ...input.copies[0], pathname: '/renamed/story.epub' }] };
    await service.report(changed, users[0]);
    expect((await service.report(input, users[0])).copies[0].status).toBe('stale');
    expect((await service.report({ ...changed, copies: [{ ...changed.copies[0], sizeBytes: 99 }] }, users[0])).copies[0].status).toBe('conflict');
    expect((await list()).items[0].pathname).toBe('/renamed/story.epub');
  });
  it('preserves provisional identity for external replacements and reconciles it without creating reading activity', async () => {
    const input = report();
    await service.report(input, users[0]);
    const changed = { ...input, sequence: 2, copies: [{ ...input.copies[0], sha256: 'b'.repeat(64), sizeBytes: 101 }] };
    await service.report(changed, users[0]);
    expect((await list()).items[0]).toMatchObject({ identity: 'provisional', revisionId: null, sha256: 'b'.repeat(64) });
    const [next] = await db
      .insert(schema.bookFileRevisions)
      .values({ bookFileId: file.id, sha256: 'b'.repeat(64), fileHash: '2'.repeat(32), sizeBytes: 101, reason: 'external_change' })
      .returning();
    await service.report({ ...changed, sequence: 3 }, users[0]);
    expect((await list()).items[0]).toMatchObject({ identity: 'known', revisionId: next.id });
    expect(await db.select().from(schema.canonicalReadingEvents).where(eq(schema.canonicalReadingEvents.userId, users[0].id))).toEqual([]);
  });
  it('serializes concurrent device reports and supplies a recovery sequence after local state loss', async () => {
    const input = report();
    await service.report(input, users[0]);
    await Promise.all(
      [2, 5, 3, 4].map((sequence) =>
        service.report(
          {
            ...input,
            sequence,
            pluginVersion: `version-${sequence}`,
            copies: [{ ...input.copies[0], pathname: `/books/story-${sequence}.epub` }],
          },
          users[0],
        ),
      ),
    );
    const current = (await list()).items[0];
    expect(current.pathname).toBe('/books/story-5.epub');
    expect((await service.listDevices({ limit: 50 }, users[0])).items[0].pluginVersion).toBe('version-5');
    const stale = await service.report(input, users[0]);
    expect(stale.nextSequence).toBe(6);
    expect(stale.copies[0].status).toBe('stale');
    expect((await service.report({ ...input, sequence: stale.nextSequence }, users[0])).copies[0].status).toBe('accepted');
  });
  it('rejects pathname collisions, foreign revision claims and mismatched sizes', async () => {
    const input = report();
    await service.report(input, users[0]);
    expect((await service.report(report(), users[0])).copies[0].status).toBe('conflict');
    for (const claim of [{ revisionId: randomUUID() }, { revisionId: revision.id, sizeBytes: 101 }]) {
      expect((await service.report({ ...input, sequence: 2, copies: [{ ...input.copies[0], ...claim }] }, users[0])).copies[0].status).toBe(
        'conflict',
      );
    }
    expect((await list()).items[0].sizeBytes).toBe(100);
  });
  it('requires policy acknowledgement after changes and isolates per-copy overrides', async () => {
    const input = report();
    await service.report(input, users[0]);
    await service.updateDevicePolicy('reader', { version: 1, policy: 'automatic' }, users[0]);
    const copy = (await list()).items[0];
    expect(copy).toMatchObject({ policy: 'automatic', policyAcknowledged: false, effectivePolicyVersion: '2:1' });
    await service.report({ ...input, sequence: 2, copies: [{ ...input.copies[0], policyAcknowledgement: '1:1' }] }, users[0]);
    expect((await list()).items[0].policyAcknowledged).toBe(false);
    await service.report({ ...input, sequence: 3, copies: [{ ...input.copies[0], policyAcknowledgement: '2:1' }] }, users[0]);
    expect((await list()).items[0].policyAcknowledged).toBe(true);
    await service.updateCopyPolicy(copy.id, { version: 1, policy: 'ignore' }, users[0]);
    expect((await list()).items[0]).toMatchObject({ policy: 'ignore', policyAcknowledged: false, effectivePolicyVersion: '2:2' });
    await expect(service.updateCopyPolicy(copy.id, { version: 1, policy: null }, users[0])).rejects.toThrow('settings changed');
    await service.updateCopyPolicy(copy.id, { version: 2, policy: null }, users[0]);
    expect((await list()).items[0]).toMatchObject({ policy: 'automatic', policyOverride: null });
  });
  it('enforces current library access, content filters, ownership and download permission', async () => {
    const input = report();
    const saved = await service.report(input, users[0]);
    await expect(service.updateCopyPolicy(saved.copies[0].id!, { version: 1, policy: 'ignore' }, users[1])).rejects.toThrow('unavailable');
    await expect(
      service.updateDevicePolicy('reader', { version: 1, policy: 'automatic' }, { ...users[0], permissions: [Permission.KoreaderSync] }),
    ).rejects.toThrow('permission');
    const filtered = { ...users[0], contentFilters: { ...EMPTY_CONTENT_FILTER_RULES, includeTagIds: [2147483647] } };
    expect((await list(filtered)).items).toEqual([]);
    expect((await service.report(input, filtered)).copies[0].status).toBe('unavailable');
    await db
      .delete(schema.userLibraryAccess)
      .where(and(eq(schema.userLibraryAccess.userId, users[0].id), eq(schema.userLibraryAccess.libraryId, libraryIds[0])));
    expect((await list()).items).toEqual([]);
    expect((await service.report(input, users[0])).copies[0].status).toBe('unavailable');
    await expect(service.report(input, { ...users[0], active: false })).rejects.toThrow('permission');
  });
  it('paginates copies and rejects cursors from another user', async () => {
    const input = report();
    input.copies = Array.from({ length: 100 }, (_, index) => ({ ...input.copies[0], copyId: randomUUID(), pathname: `/books/${index}.epub` }));
    await service.report(input, users[0]);
    const first = await service.list({ limit: 50 }, users[0]);
    const second = await service.list({ limit: 50, cursor: first.nextCursor! }, users[0]);
    expect(first.items).toHaveLength(50);
    expect(second.items).toHaveLength(50);
    expect(new Set([...first.items, ...second.items].map((copy) => copy.id)).size).toBe(100);
    expect(second.nextCursor).toBeNull();
    await expect(service.list({ limit: 50, cursor: first.nextCursor! }, users[1])).rejects.toThrow('cursor');
  });
});

import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DB } from '../src/db';
import * as schema from '../src/db/schema';
import { fanficfareConfig, storageConfig } from '../src/config/config';
import type { RequestUser } from '../src/common/types/request-user';
import { FanfictionConnectionService } from '../src/modules/fanfiction/fanfiction-connection.service';
import { FanfictionAccessService } from '../src/modules/fanfiction/fanfiction-access.service';
import { FanficfareRuntimeService } from '../src/modules/fanfiction/fanficfare-runtime.service';
import { FanfictionVaultService } from '../src/modules/fanfiction/fanfiction-vault.service';

const configPath = process.env.REVISION_TEST_DB_CONFIG;
describe.skipIf(!configPath || !process.env.FANFICFARE_TEST_PYTHON)('private website connections', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let service: FanfictionConnectionService;
  let directory: string;
  let owner: RequestUser;
  let other: RequestUser;
  const access = {
    administer: vi.fn((_user: RequestUser, library: number) => {
      if (library === 999) return Promise.reject(new ForbiddenException());
      return Promise.resolve();
    }),
  };
  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (!/^bookorbit_revision_validation_[a-z0-9]+$/.test(String(config.database))) throw new Error('Isolated validation database required');
    pool = new Pool(config);
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../src/db/migrations') });
    directory = await mkdtemp(join(tmpdir(), 'bookorbit-connections-'));
    const module = await Test.createTestingModule({
      providers: [
        FanfictionConnectionService,
        FanficfareRuntimeService,
        FanfictionVaultService,
        { provide: DB, useValue: db },
        { provide: FanfictionAccessService, useValue: access },
        { provide: storageConfig.KEY, useValue: { appDataPath: directory } },
        {
          provide: fanficfareConfig.KEY,
          useValue: {
            python: process.env.FANFICFARE_TEST_PYTHON,
            timeoutMs: 20000,
            maxWorkers: 2,
            encryptionKey: Buffer.alloc(32, 7).toString('base64'),
          },
        },
      ],
    }).compile();
    service = module.get(FanfictionConnectionService);
    const users = await db
      .insert(schema.users)
      .values(['owner', 'other'].map((name) => ({ username: `${name}-${randomUUID()}`, name, passwordHash: 'not-a-login' })))
      .returning();
    [owner, other] = users.map((user) => ({ ...user, permissions: [], contentFilters: {} }) as unknown as RequestUser);
  }, 60000);
  afterAll(async () => {
    if (owner) await db.delete(schema.users).where(eq(schema.users.id, owner.id));
    if (other) await db.delete(schema.users).where(eq(schema.users.id, other.id));
    await pool?.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it('reuses one encrypted login across authorized libraries without disclosing it to another manager', async () => {
    const connection = await service.save({ site: 'archiveofourown.org', username: 'reader', password: 'private-test-password' }, owner);
    expect(connection.lastSuccessfulAt).toBeNull();
    expect(JSON.stringify(connection)).not.toContain('reader');
    expect(JSON.stringify(await service.list(owner))).not.toContain('private-test-password');
    expect(await service.list(other)).toEqual([]);
    await expect(service.owned(connection.id, other)).rejects.toBeInstanceOf(ForbiddenException);
    const [stored] = await db.select().from(schema.fanfictionConnections).where(eq(schema.fanfictionConnections.id, connection.id));
    expect(JSON.stringify(stored.document)).not.toContain('private-test-password');
    for (const library of [1, 2]) {
      await access.administer(owner, library);
      const session = await service.session('https://archiveofourown.org/works/123', owner, () => access.administer(owner, library));
      expect(session.connection?.id).toBe(connection.id);
      expect(session.document.configuration).toContain('private-test-password');
    }
    expect((await service.session('https://archiveofourown.org/works/123', other, async () => {})).connection).toBeNull();
    await expect(service.issues(999, owner)).rejects.toBeInstanceOf(ForbiddenException);
    await service.outcome({ id: connection.id, generation: 1 }, owner.id, 'source_not_found');
    expect((await service.list(owner))[0].errorCode).toBeNull();
    await service.outcome({ id: connection.id, generation: 1 }, owner.id, 'authentication_required');
    expect((await service.list(owner))[0].errorCode).toBe('authentication_required');
    const updated = await service.save({ site: connection.website.id, version: 1, password: 'replacement' }, owner);
    await service.outcome({ id: connection.id, generation: 1 }, owner.id);
    expect((await service.list(owner))[0].lastSuccessfulAt).toBeNull();
    expect(updated.version).toBe(2);
    await expect(service.save({ site: connection.website.id, version: 1, password: 'stale' }, owner)).rejects.toThrow('changed');
    await service.remove(connection.id, owner);
    expect(await service.list(owner)).toEqual([]);
  }, 60000);
  it('rejects unsupported password forms and cookies outside the website', async () => {
    await expect(service.save({ site: 'fiction.live', password: 'not-supported' }, owner)).rejects.toThrow('browser cookies');
    await expect(
      service.save({ site: 'archiveofourown.org', cookies: [{ name: 'session', value: 'secret', domain: 'org', path: '/', secure: true }] }, owner),
    ).rejects.toThrow('belong');
  }, 30000);
});

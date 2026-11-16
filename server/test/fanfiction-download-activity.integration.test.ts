import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema';
import { downloadQueue } from '../src/modules/fanfiction/fanfiction-download-queue';

const configPath = process.env.REVISION_TEST_DB_CONFIG;
describe.skipIf(!configPath)('live download activity with scoped PostgreSQL data', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let libraryId: number;
  let userId: number;
  let otherId: number;
  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (!/^bookorbit_revision_validation(?:_[a-z0-9]+)?$/.test(config.database ?? ''))
      throw new Error('An isolated activity test database is required');
    pool = new Pool(config);
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../src/db/migrations') });
    const [library] = await db
      .insert(schema.libraries)
      .values({ name: 'activity-' + randomUUID() })
      .returning();
    libraryId = library.id;
    const users = await db
      .insert(schema.users)
      .values([0, 1].map(() => ({ username: randomUUID(), name: 'Activity test', passwordHash: 'not-a-login' })))
      .returning();
    [userId, otherId] = users.map((row) => row.id);
  }, 60000);
  afterAll(async () => {
    if (!pool) return;
    if (libraryId) await db.delete(schema.libraries).where(eq(schema.libraries.id, libraryId));
    for (const id of [userId, otherId]) if (id) await db.delete(schema.users).where(eq(schema.users.id, id));
    await pool.end();
  });
  it('counts stories inside groups and explains current waits without exposing another reader', async () => {
    const now = Date.now();
    const sample = (site: string) => ({
      libraryId,
      userId,
      tokenVersion: 0,
      kind: 'import' as const,
      site,
      url: `https://${site}/${randomUUID()}`,
      idempotencyKey: randomUUID(),
    });
    await db
      .insert(schema.fanfictionJobs)
      .values([
        { ...sample('fiction.live'), state: 'running', leaseExpiresAt: new Date(now + 60000) },
        { ...sample('example.org'), state: 'running', leaseExpiresAt: new Date(now + 60000) },
        { ...sample('fiction.live'), state: 'queued', runAfter: new Date(now - 1000) },
        { ...sample('next.example'), state: 'queued', runAfter: new Date(now - 1000) },
        { ...sample('retry.example'), state: 'queued', attempts: 2, errorCode: 'source_failed', runAfter: new Date(now + 60000) },
        { ...sample('mixed.example'), state: 'queued', attempts: 2, errorCode: 'source_failed', runAfter: new Date(now - 1000) },
        { ...sample('mixed.example'), state: 'queued', attempts: 2, errorCode: 'source_failed', runAfter: new Date(now + 60000) },
        ...Array.from({ length: 27 }, () => ({ ...sample('broken.example'), state: 'failed' as const, errorCode: 'source_failed' })),
        { ...sample('private.example'), userId: otherId, state: 'running', leaseExpiresAt: new Date(now + 60000) },
      ]);
    const page = await downloadQueue(db, libraryId, userId, { offset: 0 });
    expect(page.storyCounts).toEqual({ running: 2, queued: 2, retrying: 3, attention: 27 });
    expect(page.totals.attention).toBe(1);
    expect(page.items.find((row) => row.section === 'queued' && row.site === 'fiction.live')?.waitingFor).toBe('website_busy');
    expect(page.items.find((row) => row.site === 'next.example')?.waitingFor).toBe('downloads_busy');
    expect(page.items.find((row) => row.site === 'retry.example')?.waitingFor).toBe('scheduled_retry');
    expect(page.items.find((row) => row.site === 'mixed.example')?.waitingFor).toBe('downloads_busy');
    expect(page.items.find((row) => row.section === 'running')?.lastContactAt).toBeTruthy();
    expect(page.items.some((row) => row.site === 'private.example')).toBe(false);
    const other = await downloadQueue(db, libraryId, otherId, { offset: 0 });
    expect(other.items).toHaveLength(1);
    expect(other.items[0].site).toBe('private.example');
  }, 60000);
});

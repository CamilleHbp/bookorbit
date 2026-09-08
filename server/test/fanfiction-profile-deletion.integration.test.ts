import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FanfictionJobState } from '@bookorbit/types';
import { DB } from '../src/db';
import * as schema from '../src/db/schema';
import type { RequestUser } from '../src/common/types/request-user';
import { FanfictionProfileService } from '../src/modules/fanfiction/fanfiction-profile.service';
import { FanfictionAccessService } from '../src/modules/fanfiction/fanfiction-access.service';
import { FanficfareRuntimeService } from '../src/modules/fanfiction/fanficfare-runtime.service';
import { FanfictionVaultService } from '../src/modules/fanfiction/fanfiction-vault.service';
import { FanfictionJobService } from '../src/modules/fanfiction/fanfiction-job.service';

const configPath = process.env.REVISION_TEST_DB_CONFIG;
describe.skipIf(!configPath)('profile deletion with PostgreSQL', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let service: FanfictionProfileService;
  let jobs: FanfictionJobService;
  let libraryId: number;
  let profileId: string;
  let user: RequestUser;
  const access = { administer: vi.fn(async () => {}) };
  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as PoolConfig;
    if (config.database !== 'bookorbit_revision_validation') throw new Error('An isolated validation database is required');
    pool = new Pool(config);
    db = drizzle(pool, { schema });
    const module = await Test.createTestingModule({
      providers: [
        FanfictionProfileService,
        FanfictionJobService,
        { provide: DB, useValue: db },
        { provide: FanfictionAccessService, useValue: access },
        { provide: FanficfareRuntimeService, useValue: {} },
        { provide: FanfictionVaultService, useValue: {} },
      ],
    }).compile();
    service = module.get(FanfictionProfileService);
    jobs = module.get(FanfictionJobService);
    const [account] = await db
      .insert(schema.users)
      .values({ username: `delete-test-${randomUUID()}`, name: 'Deletion test', passwordHash: 'not-a-login-hash' })
      .returning();
    user = { ...account, permissions: [], contentFilters: {} } as RequestUser;
  });
  beforeEach(async () => {
    access.administer.mockReset().mockResolvedValue(undefined);
    const [library] = await db
      .insert(schema.libraries)
      .values({ name: `delete-test-${randomUUID()}` })
      .returning();
    libraryId = library.id;
    profileId = randomUUID();
    await db.insert(schema.fanfictionProfiles).values({
      id: profileId,
      libraryId,
      createdBy: user.id,
      name: 'AO3',
      document: { version: 1, keyId: 'fixture', iv: '', tag: '', ciphertext: 'fixture' },
    });
  });
  afterEach(async () => {
    await db.delete(schema.libraries).where(eq(schema.libraries.id, libraryId));
  });
  afterAll(async () => {
    if (user) await db.delete(schema.users).where(eq(schema.users.id, user.id));
    await pool?.end();
  });
  async function addJob(state: FanfictionJobState) {
    const [job] = await db
      .insert(schema.fanfictionJobs)
      .values({
        libraryId,
        profileId,
        userId: user.id,
        tokenVersion: user.tokenVersion,
        idempotencyKey: randomUUID(),
        kind: 'preview',
        state,
        url: 'https://example.org/story',
        site: 'example.org',
      })
      .returning();
    return job;
  }
  async function remainingProfile() {
    return db.select({ id: schema.fanfictionProfiles.id }).from(schema.fanfictionProfiles).where(eq(schema.fanfictionProfiles.id, profileId));
  }
  it('deletes an unused profile without needing runtime or vault access', async () => {
    await service.remove(libraryId, profileId, user);
    expect(await remainingProfile()).toEqual([]);
    expect(access.administer).toHaveBeenCalledWith(user, libraryId);
    await expect(service.remove(libraryId, profileId, user)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('denies unauthorized and wrong-library deletion without changing the profile', async () => {
    access.administer.mockRejectedValueOnce(new ForbiddenException());
    await expect(service.remove(libraryId, profileId, user)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.remove(libraryId + 1, profileId, user)).rejects.toBeInstanceOf(NotFoundException);
    expect(await remainingProfile()).toHaveLength(1);
  });
  it.each(['queued', 'running', 'review_required', 'configuration_blocked'] as const)('preserves profiles used by %s activity', async (state) => {
    await addJob(state);
    await expect(service.remove(libraryId, profileId, user)).rejects.toBeInstanceOf(ConflictException);
    expect(await remainingProfile()).toHaveLength(1);
  });
  it('keeps completed history and prevents retrying failed activity without its deleted credentials', async () => {
    const success = await addJob('succeeded');
    const failed = await addJob('failed');
    await service.remove(libraryId, profileId, user);
    const history = await db.select().from(schema.fanfictionJobs).where(eq(schema.fanfictionJobs.libraryId, libraryId));
    expect(history).toHaveLength(2);
    expect(history.find((job) => job.id === success.id)).toMatchObject({ profileId: null, state: 'succeeded', errorCode: null });
    expect(history.find((job) => job.id === failed.id)).toMatchObject({ profileId: null, state: 'failed', errorCode: 'profile_deleted' });
    await expect(jobs.retry(libraryId, failed.id, user)).rejects.toThrow('profile was deleted');
  });
  it('protects profiles referenced by older adoption selections', async () => {
    const job = await addJob('queued');
    await db
      .update(schema.fanfictionJobs)
      .set({
        kind: 'adopt',
        profileId: null,
        selection: {
          profileId,
          cutoff: new Date().toISOString(),
          cursor: null,
          ids: [],
          decision: 'approve',
          intervalMinutes: 1440,
          processed: 0,
          failed: 0,
        },
      })
      .where(eq(schema.fanfictionJobs.id, job.id));
    await expect(service.remove(libraryId, profileId, user)).rejects.toBeInstanceOf(ConflictException);
    await db.update(schema.fanfictionJobs).set({ state: 'failed' }).where(eq(schema.fanfictionJobs.id, job.id));
    await service.remove(libraryId, profileId, user);
    await expect(jobs.retry(libraryId, job.id, user)).rejects.toThrow('profile was deleted');
  });
  it('requires changing the profile on linked stories but preserves unlinked stories', async () => {
    const [source] = await db
      .insert(schema.fanfictionSources)
      .values({
        libraryId,
        profileId,
        createdBy: user.id,
        canonicalUrl: 'https://example.org/story',
        canonicalKey: randomUUID(),
        site: 'example.org',
        title: 'Story',
        state: 'paused',
        importOperationId: randomUUID(),
        relativePath: 'story.epub',
      })
      .returning();
    await expect(service.remove(libraryId, profileId, user)).rejects.toThrow('assigned to stories');
    expect(await remainingProfile()).toHaveLength(1);
    await db.update(schema.fanfictionSources).set({ state: 'unlinked' }).where(eq(schema.fanfictionSources.id, source.id));
    await service.remove(libraryId, profileId, user);
    const [preserved] = await db.select().from(schema.fanfictionSources).where(eq(schema.fanfictionSources.id, source.id));
    expect(preserved).toMatchObject({ id: source.id, profileId: null, state: 'unlinked', title: 'Story' });
  });
});

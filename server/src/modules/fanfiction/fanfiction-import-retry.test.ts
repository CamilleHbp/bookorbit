import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { ImportFanfictionDto } from './dto/fanfiction-source.dto';
import { Test } from '@nestjs/testing';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { RequestUser } from '../../common/types/request-user';
import { FanfictionJobService } from './fanfiction-job.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionProfileService } from './fanfiction-profile.service';

describe('blocked import recovery', () => {
  async function setup(denied = false) {
    const job = {
      id: 'job',
      libraryId: 5,
      kind: 'import',
      state: 'configuration_blocked',
      sourceId: 'source',
      sourceVersion: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const source = { id: 'source', libraryId: 5, state: 'configuration_blocked', version: 1, bookFileId: null };
    const pages = [[job], [source], []];
    const writes: { table: unknown; values: Record<string, unknown> }[] = [];
    const tx = {
      select: vi.fn(() => ({
        from: () => ({ where: () => ({ for: () => Promise.resolve(pages.shift()), limit: () => Promise.resolve(pages.shift()) }) }),
      })),
      update: vi.fn((table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          writes.push({ table, values });
          return { where: () => ({ returning: () => Promise.resolve([{ ...job, ...values, updatedAt: new Date() }]) }) };
        },
      })),
    };
    const profiles = { document: denied ? vi.fn().mockRejectedValue(new ForbiddenException()) : vi.fn() };
    const module = await Test.createTestingModule({
      providers: [
        FanfictionJobService,
        { provide: DB, useValue: { transaction: (fn: (value: typeof tx) => unknown) => fn(tx) } },
        { provide: FanfictionAccessService, useValue: { administer: vi.fn() } },
        { provide: FanfictionProfileService, useValue: profiles },
      ],
    }).compile();
    return { module, service: module.get(FanfictionJobService), writes, profiles };
  }
  it('accepts identical metadata after serialization and rejects edits under the same request key', async () => {
    const dto = plainToInstance(ImportFanfictionDto, {
      url: 'https://fiction.live/stories/story/id',
      folderId: 8,
      idempotencyKey: 'key',
      metadata: { title: 'My title' },
    });
    const existing = {
      id: 'job',
      libraryId: 5,
      userId: 7,
      profileId: null,
      url: dto.url,
      kind: 'import',
      state: 'queued',
      input: { folderId: 8, intervalMinutes: 1440, metadata: { title: 'My title' } },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }) }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([existing]) }) }) }),
    };
    const module = await Test.createTestingModule({
      providers: [
        FanfictionJobService,
        { provide: DB, useValue: db },
        { provide: FanfictionAccessService, useValue: { administer: vi.fn() } },
        { provide: FanfictionProfileService, useValue: {} },
      ],
    }).compile();
    const service = module.get(FanfictionJobService);
    expect((await service.importStory(5, dto, { id: 7 } as RequestUser)).id).toBe('job');
    await expect(service.importStory(5, { ...dto, metadata: { title: 'Different title' } }, { id: 7 } as RequestUser)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await module.close();
  });
  it('resumes the reserved story with the chosen credentials', async () => {
    const { module, service, writes, profiles } = await setup();
    const user = { id: 7, tokenVersion: 1 } as RequestUser;
    const result = await service.retry(5, 'job', user, undefined, 'new-profile');
    expect(profiles.document).toHaveBeenCalledWith(5, 'new-profile', user);
    expect(result.id).toBe('job');
    expect(result.state).toBe('queued');
    expect(writes.find((write) => write.table === schema.fanfictionSources)?.values).toMatchObject({ state: 'pending', profileId: 'new-profile' });
    expect(writes.find((write) => write.table === schema.fanfictionJobs)?.values).toMatchObject({ state: 'queued', profileId: 'new-profile' });
    await module.close();
  });
  it('does not mutate the job when the chosen profile is inaccessible', async () => {
    const { module, service, writes } = await setup(true);
    await expect(service.retry(5, 'job', { id: 7 } as RequestUser, undefined, 'private-profile')).rejects.toBeInstanceOf(ForbiddenException);
    expect(writes).toHaveLength(0);
    await module.close();
  });
});

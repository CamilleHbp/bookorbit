import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DB } from '../../db';
import type { RequestUser } from '../../common/types/request-user';
import { FanfictionProfileService } from './fanfiction-profile.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionVaultService } from './fanfiction-vault.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { CreateFanfictionProfileDto } from './dto/fanfiction-profile.dto';

const rule = { remoteTag: 'Remote adventure', targetTag: 'Adventure' };
const row = { id: 'profile', libraryId: 5, name: 'Source', version: 1, credentialGeneration: 1, document: {}, updatedAt: new Date() };
const user = { id: 7 } as RequestUser;

describe('source profile tag rules', () => {
  const access = { administer: vi.fn() };
  const vault = { decrypt: vi.fn(), encrypt: vi.fn().mockResolvedValue({}) };
  const runtime = { mergeConfiguration: vi.fn().mockResolvedValue('[defaults]\n') };
  const query = { from: vi.fn(), where: vi.fn(), limit: vi.fn(), set: vi.fn(), values: vi.fn(), returning: vi.fn() };
  const db = { select: vi.fn(() => query), insert: vi.fn(() => query), update: vi.fn(() => query) };
  let service: FanfictionProfileService;
  beforeEach(async () => {
    vi.clearAllMocks();
    for (const key of ['from', 'where', 'set', 'values'] as const) query[key].mockReturnValue(query);
    query.limit.mockResolvedValue([row]);
    query.returning.mockResolvedValue([row]);
    vault.decrypt.mockResolvedValue(JSON.stringify({ configuration: '[defaults]\n', cookies: [], tagRules: [rule] }));
    const module = await Test.createTestingModule({
      providers: [
        FanfictionProfileService,
        { provide: DB, useValue: db },
        { provide: FanfictionAccessService, useValue: access },
        { provide: FanfictionVaultService, useValue: vault },
        { provide: FanficfareRuntimeService, useValue: runtime },
      ],
    }).compile();
    service = module.get(FanfictionProfileService);
  });
  it('returns saved rules and retains them when an older client edits credentials', async () => {
    expect((await service.get(5, 'profile', user)).tagRules).toEqual([rule]);
    await service.update(5, 'profile', { name: 'Source', version: 1 }, user);
    expect(JSON.parse(vault.encrypt.mock.calls[0]![2])).toMatchObject({ tagRules: [rule] });
  });
  it('saves rules on creation and supports explicitly clearing them', async () => {
    query.limit.mockResolvedValueOnce([]);
    await service.create(5, { name: 'Source', tagRules: [rule] }, user);
    expect(JSON.parse(vault.encrypt.mock.calls[0]![2])).toMatchObject({ tagRules: [rule] });
    await service.update(5, 'profile', { name: 'Source', version: 1, tagRules: [] }, user);
    expect(JSON.parse(vault.encrypt.mock.calls[1]![2])).toMatchObject({ tagRules: [] });
  });
  it('rejects ambiguous mappings before writing them', async () => {
    await expect(
      service.create(5, { name: 'Source', tagRules: [rule, { remoteTag: ' REMOTE ADVENTURE ', targetTag: 'Other' }] }, user),
    ).rejects.toThrow('Use each remote tag only once');
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('requires the existing library administration permission', async () => {
    access.administer.mockRejectedValueOnce(new ForbiddenException());
    await expect(service.create(5, { name: 'Source', tagRules: [rule] }, user)).rejects.toThrow(ForbiddenException);
    expect(db.insert).not.toHaveBeenCalled();
    expect(vault.encrypt).not.toHaveBeenCalled();
  });
  it('validates bounded structured rules in the request DTO', async () => {
    const options = { whitelist: true, forbidNonWhitelisted: true };
    expect(await validate(plainToInstance(CreateFanfictionProfileDto, { name: 'Source', tagRules: [rule] }), options)).toEqual([]);
    for (const tagRules of [[{ remoteTag: ' ', targetTag: 'A' }], [{ remoteTag: 'A', targetTag: 'B', unknown: true }], Array(101).fill(rule)]) {
      expect((await validate(plainToInstance(CreateFanfictionProfileDto, { name: 'Source', tagRules }), options)).length).toBeGreaterThan(0);
    }
  });
});

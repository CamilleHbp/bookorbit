import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { RequestUser } from '../../common/types/request-user';
import { DB } from '../../db';
import { FanfictionSourceService } from './fanfiction-source.service';
import type * as schema from '../../db/schema';
import { UserService } from '../user/user.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionLibraryController } from './fanfiction-library.controller';
import { FanfictionPreferencesDto } from './dto/fanfiction.dto';

describe('fanfiction account defaults', () => {
  it.each([undefined, 'safe', 'review'] as const)('resolves the maintained account policy: %s', async (policy) => {
    const users = { findByIdWithPermissions: vi.fn().mockResolvedValue({ settings: { fanfictionDefaultUpdatePolicy: policy } }) };
    const module = await Test.createTestingModule({ providers: [FanfictionAccessService, { provide: UserService, useValue: users }] })
      .useMocker(() => ({}))
      .compile();
    await expect(module.get(FanfictionAccessService).defaultUpdatePolicy(7)).resolves.toBe(policy ?? 'safe');
    expect(users.findByIdWithPermissions).toHaveBeenCalledWith(7);
    await module.close();
  });
  it.each(['safe', 'review'] as const)('inherits %s for existing stories while preserving explicit safe overrides', async (policy) => {
    const access = { defaultUpdatePolicy: vi.fn().mockResolvedValue(policy) };
    const module = await Test.createTestingModule({
      providers: [
        FanfictionSourceService,
        { provide: FanfictionAccessService, useValue: access },
        { provide: DB, useValue: { transaction: (operation: (tx: unknown) => unknown) => operation({}) } },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    const service = module.get(FanfictionSourceService);
    const source = { updatePolicy: 'review' } as typeof schema.fanfictionSources.$inferSelect;
    vi.spyOn(service, 'assertUpdatable').mockResolvedValue(source);
    const job = { userId: 7 } as typeof schema.fanfictionJobs.$inferSelect;
    expect((await service.updateContext(job)).updatePolicy).toBe(policy);
    expect(access.defaultUpdatePolicy).toHaveBeenCalledWith(7);
    source.updatePolicy = 'safe';
    access.defaultUpdatePolicy.mockClear();
    expect((await service.updateContext(job)).updatePolicy).toBe('safe');
    expect(access.defaultUpdatePolicy).not.toHaveBeenCalled();
    await module.close();
  });
  it('saves the policy independently of adult confirmation', async () => {
    const user = { id: 7 } as RequestUser;
    const users = { updateMySettings: vi.fn().mockResolvedValue({ settings: { fanfictionIsAdult: true, fanfictionDefaultUpdatePolicy: 'review' } }) };
    const module = await Test.createTestingModule({
      controllers: [FanfictionLibraryController],
      providers: [
        { provide: UserService, useValue: users },
        { provide: FanfictionAccessService, useValue: {} },
      ],
    }).compile();
    await expect(module.get(FanfictionLibraryController).savePreferences({ defaultUpdatePolicy: 'review' }, user)).resolves.toEqual({
      isAdult: true,
      defaultUpdatePolicy: 'review',
    });
    expect(users.updateMySettings).toHaveBeenCalledWith(user, { settings: { fanfictionDefaultUpdatePolicy: 'review' } });
    await module.close();
  });
  it('rejects invalid policies and accepts a policy-only update', async () => {
    expect(await validate(plainToInstance(FanfictionPreferencesDto, { defaultUpdatePolicy: 'unsafe' }))).toHaveLength(1);
    expect(await validate(plainToInstance(FanfictionPreferencesDto, { defaultUpdatePolicy: 'safe' }))).toHaveLength(0);
  });
});

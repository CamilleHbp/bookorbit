import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '../../common/types/request-user';
import { UserService } from '../user/user.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionLibraryController } from './fanfiction-library.controller';
import { FanfictionPreferencesDto, RetryFanfictionJobDto } from './dto/fanfiction-profile.dto';

describe('account story preferences', () => {
  it('writes only the current user preference using merged settings', async () => {
    const users = { updateMySettings: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [FanfictionLibraryController, { provide: UserService, useValue: users }, { provide: FanfictionAccessService, useValue: {} }],
    }).compile();
    const controller = module.get(FanfictionLibraryController);
    const user = { id: 7, settings: {} } as RequestUser;
    expect(controller.preferences(user)).toEqual({ isAdult: false });
    expect(await controller.savePreferences({ isAdult: true }, user)).toEqual({ isAdult: true });
    expect(users.updateMySettings).toHaveBeenCalledWith(7, { settings: { fanfictionIsAdult: true } });
    await module.close();
  });
  it('rejects nonboolean preferences, unknown fields and invalid retry profiles', async () => {
    expect(await validate(plainToInstance(FanfictionPreferencesDto, { isAdult: 'true' }))).not.toHaveLength(0);
    expect(
      await validate(plainToInstance(FanfictionPreferencesDto, { isAdult: true, userId: 9 }), { whitelist: true, forbidNonWhitelisted: true }),
    ).not.toHaveLength(0);
    expect(await validate(plainToInstance(RetryFanfictionJobDto, { profileId: 'not-a-uuid' }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(RetryFanfictionJobDto, {}))).toHaveLength(0);
  });
});

import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { FanfictionAccessService } from './fanfiction-access.service';
import { UserService } from '../user/user.service';
import type { FanfictionPreferences } from '@bookorbit/types';
import { FanfictionPreferencesDto, FanfictionLibrariesDto } from './dto/fanfiction.dto';

@Controller('fanfiction')
export class FanfictionLibraryController {
  constructor(
    private readonly access: FanfictionAccessService,
    private readonly users: UserService,
  ) {}

  @Get('preferences')
  @RequirePermission(Permission.ManageLibraries)
  preferences(@CurrentUser() user: RequestUser): FanfictionPreferences {
    return {
      isAdult: user.settings?.fanfictionIsAdult === true,
      defaultUpdatePolicy: user.settings?.fanfictionDefaultUpdatePolicy === 'review' ? 'review' : 'safe',
    };
  }

  @Patch('preferences')
  @RequirePermission(Permission.ManageLibraries)
  async savePreferences(@Body() dto: FanfictionPreferencesDto, @CurrentUser() user: RequestUser): Promise<FanfictionPreferences> {
    const updated = await this.users.updateMySettings(user, {
      settings: {
        ...(dto.isAdult !== undefined ? { fanfictionIsAdult: dto.isAdult } : {}),
        ...(dto.defaultUpdatePolicy !== undefined ? { fanfictionDefaultUpdatePolicy: dto.defaultUpdatePolicy } : {}),
      },
    });
    const settings = updated.settings as Record<string, unknown> | null;
    return {
      isAdult: settings?.fanfictionIsAdult === true,
      defaultUpdatePolicy: settings?.fanfictionDefaultUpdatePolicy === 'review' ? 'review' : 'safe',
    };
  }

  @Get('libraries')
  @RequirePermission(Permission.ManageLibraries)
  libraries(@Query() dto: FanfictionLibrariesDto, @CurrentUser() user: RequestUser) {
    return this.access.librariesFor(user, dto.cursor, dto.limit);
  }
}

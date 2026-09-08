import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { FanfictionAccessService } from './fanfiction-access.service';
import { UserService } from '../user/user.service';
import type { FanfictionPreferences } from '@bookorbit/types';
import { FanfictionPreferencesDto, FanfictionLibrariesDto } from './dto/fanfiction-profile.dto';

@Controller('fanfiction')
export class FanfictionLibraryController {
  constructor(
    private readonly access: FanfictionAccessService,
    private readonly users: UserService,
  ) {}

  @Get('preferences')
  @RequirePermission(Permission.ManageLibraries)
  preferences(@CurrentUser() user: RequestUser): FanfictionPreferences {
    return { isAdult: user.settings?.fanfictionIsAdult === true };
  }

  @Patch('preferences')
  @RequirePermission(Permission.ManageLibraries)
  async savePreferences(@Body() dto: FanfictionPreferencesDto, @CurrentUser() user: RequestUser): Promise<FanfictionPreferences> {
    await this.users.updateMySettings(user.id, { settings: { fanfictionIsAdult: dto.isAdult } });
    return { isAdult: dto.isAdult };
  }

  @Get('libraries')
  @RequirePermission(Permission.ManageLibraries)
  libraries(@Query() dto: FanfictionLibrariesDto, @CurrentUser() user: RequestUser) {
    return this.access.librariesFor(user, dto.cursor, dto.limit);
  }
}

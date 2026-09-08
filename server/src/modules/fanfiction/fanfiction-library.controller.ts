import { Controller, Get, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionLibrariesDto } from './dto/fanfiction-profile.dto';

@Controller('fanfiction')
export class FanfictionLibraryController {
  constructor(private readonly access: FanfictionAccessService) {}

  @Get('libraries')
  @RequirePermission(Permission.ManageLibraries)
  libraries(@Query() dto: FanfictionLibrariesDto, @CurrentUser() user: RequestUser) {
    return this.access.librariesFor(user, dto.cursor, dto.limit);
  }
}

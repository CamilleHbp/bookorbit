import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RequireLibraryAccess } from '../../common/decorators/require-library-access.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { ImportFanfictionDto, ListFanfictionSourcesDto, UpdateFanfictionSourceDto } from './dto/fanfiction-source.dto';
import { FanfictionSourceService } from './fanfiction-source.service';
import { FanfictionLibrariesDto } from './dto/fanfiction-profile.dto';

@Controller('libraries/:libraryId/fanfiction/sources')
@RequirePermission(Permission.ManageLibraries)
@RequireLibraryAccess('owner')
export class FanfictionSourceController {
  constructor(private readonly sources: FanfictionSourceService) {}

  @Post()
  @HttpCode(202)
  create(@Param('libraryId', ParseIntPipe) libraryId: number, @Body() dto: ImportFanfictionDto, @CurrentUser() user: RequestUser) {
    return this.sources.create(libraryId, dto, user);
  }

  @Get()
  list(@Param('libraryId', ParseIntPipe) libraryId: number, @Query() dto: ListFanfictionSourcesDto, @CurrentUser() user: RequestUser) {
    return this.sources.list(libraryId, dto, user);
  }

  @Get('folders')
  folders(@Param('libraryId', ParseIntPipe) libraryId: number, @Query() dto: FanfictionLibrariesDto, @CurrentUser() user: RequestUser) {
    return this.sources.folders(libraryId, dto.cursor, dto.limit, user);
  }

  @Get(':sourceId')
  get(@Param('libraryId', ParseIntPipe) libraryId: number, @Param('sourceId', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.sources.get(libraryId, id, user);
  }

  @Patch(':sourceId')
  update(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('sourceId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFanfictionSourceDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.sources.update(libraryId, id, dto, user);
  }
}

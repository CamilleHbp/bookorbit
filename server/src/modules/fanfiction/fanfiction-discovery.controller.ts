import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RequireLibraryAccess } from '../../common/decorators/require-library-access.decorator';
import type { RequestUser } from '../../common/types/request-user';
import {
  PreviewStoryLinkDto,
  ListFanfictionWebsitesDto,
  CompareFanfictionDiscoveryDto,
  StartFanfictionDiscoveryDto,
  ListFanfictionDiscoveryDto,
  SelectFanfictionDiscoveryDto,
} from './dto/fanfiction-discovery.dto';
import { FanfictionDiscoveryService } from './fanfiction-discovery.service';
import { FanfictionAdoptionService } from './fanfiction-adoption.service';

@Controller('libraries/:libraryId/fanfiction/discovery')
@RequirePermission(Permission.ManageLibraries)
@RequireLibraryAccess('owner')
export class FanfictionDiscoveryController {
  constructor(
    private readonly discovery: FanfictionDiscoveryService,
    private readonly adoption: FanfictionAdoptionService,
  ) {}

  @Get('websites')
  websites(@Param('libraryId', ParseIntPipe) libraryId: number, @Query() dto: ListFanfictionWebsitesDto, @CurrentUser() user: RequestUser) {
    return this.discovery.websites(libraryId, dto, user);
  }

  @Post(':id/compare')
  compare(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompareFanfictionDiscoveryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.discovery.compare(libraryId, id, dto, user);
  }

  @Post('book')
  previewBook(@Param('libraryId', ParseIntPipe) libraryId: number, @Body() dto: PreviewStoryLinkDto, @CurrentUser() user: RequestUser) {
    return this.discovery.previewBook(libraryId, dto, user);
  }

  @Post()
  @HttpCode(202)
  start(@Param('libraryId', ParseIntPipe) libraryId: number, @Body() dto: StartFanfictionDiscoveryDto, @CurrentUser() user: RequestUser) {
    return this.discovery.start(libraryId, dto.idempotencyKey, user);
  }

  @Get()
  list(@Param('libraryId', ParseIntPipe) libraryId: number, @Query() dto: ListFanfictionDiscoveryDto, @CurrentUser() user: RequestUser) {
    return this.discovery.list(libraryId, dto, user);
  }

  @Post('selection')
  @HttpCode(202)
  select(@Param('libraryId', ParseIntPipe) libraryId: number, @Body() dto: SelectFanfictionDiscoveryDto, @CurrentUser() user: RequestUser) {
    return this.adoption.start(libraryId, dto, user);
  }
}

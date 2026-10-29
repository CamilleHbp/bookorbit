import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RequireLibraryAccess } from '../../common/decorators/require-library-access.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { FanfictionSourceBatchService } from './fanfiction-source-batch.service';
import { FanfictionSourceBatchScopeDto, SelectFanfictionSourcesDto } from './dto/fanfiction-source-batch.dto';
import { FanfictionPageDto } from './dto/fanfiction.dto';

@Controller('libraries/:libraryId/fanfiction/source-batches')
@RequirePermission(Permission.ManageLibraries)
@RequireLibraryAccess('owner')
export class FanfictionSourceBatchController {
  constructor(private readonly batches: FanfictionSourceBatchService) {}

  @Get('scope')
  scope(@Param('libraryId', ParseIntPipe) libraryId: number, @Query() dto: FanfictionSourceBatchScopeDto, @CurrentUser() user: RequestUser) {
    return this.batches.scope(libraryId, dto, user);
  }

  @Get(':jobId/status')
  status(@Param('libraryId', ParseIntPipe) libraryId: number, @Param('jobId', ParseUUIDPipe) jobId: string, @CurrentUser() user: RequestUser) {
    return this.batches.status(libraryId, jobId, user);
  }

  @Post()
  @HttpCode(202)
  start(@Param('libraryId', ParseIntPipe) libraryId: number, @Body() dto: SelectFanfictionSourcesDto, @CurrentUser() user: RequestUser) {
    return this.batches.start(libraryId, dto, user);
  }

  @Get(':jobId/failures')
  listFailures(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Query() dto: FanfictionPageDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.batches.listFailures(libraryId, jobId, dto.cursor, dto.limit, user);
  }
}

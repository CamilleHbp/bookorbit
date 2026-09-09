import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RequireLibraryAccess } from '../../common/decorators/require-library-access.decorator';
import type { RequestUser } from '../../common/types/request-user';
import {
  CheckFanfictionSourceDto,
  ImportFanfictionDto,
  ListFanfictionSourcesDto,
  UpdateFanfictionSourceDto,
  RollbackFanfictionSourceDto,
  ResolveFanfictionMetadataDto,
} from './dto/fanfiction-source.dto';
import { FanfictionSourceService } from './fanfiction-source.service';
import { FanfictionLibrariesDto } from './dto/fanfiction-profile.dto';
import { FanfictionReviewService } from './fanfiction-review.service';

@Controller('libraries/:libraryId/fanfiction/sources')
@RequirePermission(Permission.ManageLibraries)
@RequireLibraryAccess('owner')
export class FanfictionSourceController {
  constructor(
    private readonly sources: FanfictionSourceService,
    private readonly reviews: FanfictionReviewService,
  ) {}

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

  @Get(':sourceId/metadata-review')
  metadataReview(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('sourceId', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.sources.metadataReview(libraryId, id, user);
  }

  @Post(':sourceId/metadata-review')
  resolveMetadata(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('sourceId', ParseUUIDPipe) id: string,
    @Body() dto: ResolveFanfictionMetadataDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.sources.resolveMetadata(libraryId, id, dto, user);
  }

  @Post(':sourceId/metadata-review/:action')
  reviewAction(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('sourceId', ParseUUIDPipe) id: string,
    @Param('action') action: string,
    @Body() dto: ResolveFanfictionMetadataDto,
    @CurrentUser() user: RequestUser,
  ) {
    if (action !== 'later' && action !== 'discard') throw new BadRequestException('Invalid review action');
    return this.reviews.decide(libraryId, id, dto, user, action);
  }

  @Post(':sourceId/check')
  @HttpCode(202)
  check(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('sourceId', ParseUUIDPipe) id: string,
    @Body() dto: CheckFanfictionSourceDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.sources.check(libraryId, id, dto.kind, dto.idempotencyKey, user);
  }

  @Post(':sourceId/rollback')
  @HttpCode(202)
  rollback(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('sourceId', ParseUUIDPipe) id: string,
    @Body() dto: RollbackFanfictionSourceDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.sources.rollback(libraryId, id, dto, user);
  }
}

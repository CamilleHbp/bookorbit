import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { ListRevisionsDto, ResolveReadingAnchorDto } from './dto/reading-anchor.dto';
import { RevisionApiService } from './revision-api.service';

@Controller('libraries/:libraryId/files/:fileId/revisions')
export class RevisionController {
  constructor(private readonly service: RevisionApiService) {}

  @Get()
  list(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Query() dto: ListRevisionsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(libraryId, fileId, dto, user);
  }

  @Get(':revisionId/manifest')
  manifest(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.manifest(libraryId, fileId, revisionId, user);
  }

  @Post('resolve')
  @HttpCode(200)
  resolve(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Body() dto: ResolveReadingAnchorDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.resolve(libraryId, fileId, dto, user);
  }
}

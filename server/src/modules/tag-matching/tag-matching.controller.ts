import { TagMatchingJobsService } from './tag-matching-jobs.service';
import { MatchingPreviewDto } from './tag-matching.dto';
import { Body, Controller, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Put } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { MatchingSuggestionsDto, MatchingLibraryDto, MatchingPageDto, MatchingVersionDto, SaveMatchingRuleDto } from './tag-matching.dto';
import { TagMatchingManagementService } from './tag-matching-management.service';
@Controller('tag-matching')
@RequirePermission(Permission.LibraryEditMetadata)
export class TagMatchingController {
  constructor(
    private readonly service: TagMatchingManagementService,
    private readonly jobs: TagMatchingJobsService,
  ) {}
  @Post('previews') createPreview(@CurrentUser() user: RequestUser, @Body() dto: MatchingPreviewDto) {
    return this.jobs.create(user, dto.overrideFields);
  }
  @Get('jobs/latest') latestJob(@CurrentUser() user: RequestUser) {
    return this.jobs.latest(user);
  }
  @Get('jobs/:id') jobItems(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Query() dto: MatchingPageDto) {
    return this.jobs.items(user, id, dto.page, dto.pageSize);
  }
  @Get('jobs/:id/books/:bookId') bookPreview(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('bookId', ParseIntPipe) bookId: number,
    @Query() dto: MatchingPageDto,
  ) {
    return this.jobs.details(user, id, bookId, dto.page, dto.pageSize);
  }
  @Post('jobs/:id/advance') advanceJob(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.advance(user, id);
  }
  @Post('jobs/:id/apply') applyJob(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.apply(user, id);
  }
  @Post('initialize') initialize(@CurrentUser() user: RequestUser) {
    return this.service.initialize(user);
  }
  @Post('libraries') attach(@CurrentUser() user: RequestUser, @Body() dto: MatchingLibraryDto) {
    return this.service.attach(user, dto.libraryId);
  }
  @Get('rules') list(@CurrentUser() user: RequestUser, @Query() query: MatchingPageDto) {
    return this.service.list(user, query);
  }
  @Get('review') review(@CurrentUser() user: RequestUser, @Query() query: MatchingPageDto) {
    return this.service.review(user, query);
  }
  @Get('suggestions')
  suggestions(@CurrentUser() user: RequestUser, @Query() query: MatchingSuggestionsDto) {
    return this.service.suggestions(user, query.search, query.field);
  }
  @Put('rules') save(@CurrentUser() user: RequestUser, @Body() dto: SaveMatchingRuleDto) {
    return this.service.save(user, dto);
  }
  @Delete('rules/:id') remove(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MatchingVersionDto) {
    return this.service.remove(user, id, dto.version);
  }
}

import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RequireLibraryAccess } from '../../common/decorators/require-library-access.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { FanfictionProfileService } from './fanfiction-profile.service';
import {
  CreateFanfictionProfileDto,
  ListFanfictionProfilesDto,
  PreviewFanfictionDto,
  UpdateFanfictionProfileDto,
  FanfictionJobsStatusDto,
} from './dto/fanfiction-profile.dto';
import { FanfictionJobService } from './fanfiction-job.service';

@Controller('libraries/:libraryId/fanfiction')
@RequirePermission(Permission.ManageLibraries)
@RequireLibraryAccess('owner')
export class FanfictionController {
  constructor(
    private readonly access: FanfictionAccessService,
    private readonly runtime: FanficfareRuntimeService,
    private readonly profiles: FanfictionProfileService,
    private readonly jobs: FanfictionJobService,
  ) {}

  @Post('previews')
  @HttpCode(202)
  preview(@Param('libraryId', ParseIntPipe) libraryId: number, @Body() dto: PreviewFanfictionDto, @CurrentUser() user: RequestUser) {
    return this.jobs.preview(libraryId, dto, user);
  }

  @Get('jobs')
  listJobs(@Param('libraryId', ParseIntPipe) libraryId: number, @Query() dto: ListFanfictionProfilesDto, @CurrentUser() user: RequestUser) {
    return this.jobs.list(libraryId, dto, user);
  }

  @Post('jobs/status')
  @HttpCode(200)
  jobStatus(@Param('libraryId', ParseIntPipe) libraryId: number, @Body() dto: FanfictionJobsStatusDto, @CurrentUser() user: RequestUser) {
    return this.jobs.status(libraryId, dto.ids, user);
  }

  @Get('jobs/:jobId')
  job(@Param('libraryId', ParseIntPipe) libraryId: number, @Param('jobId', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.jobs.get(libraryId, id, user);
  }

  @Post('jobs/:jobId/cancel')
  @HttpCode(202)
  cancelJob(@Param('libraryId', ParseIntPipe) libraryId: number, @Param('jobId', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.jobs.cancel(libraryId, id, user);
  }

  @Get('runtime')
  async health(@Param('libraryId', ParseIntPipe) libraryId: number, @CurrentUser() user: RequestUser) {
    await this.access.administer(user, libraryId);
    return this.runtime.health();
  }

  @Get('sites')
  async sites(@Param('libraryId', ParseIntPipe) libraryId: number, @CurrentUser() user: RequestUser) {
    await this.access.administer(user, libraryId);
    return this.runtime.sites();
  }

  @Get('profiles')
  list(@Param('libraryId', ParseIntPipe) libraryId: number, @Query() dto: ListFanfictionProfilesDto, @CurrentUser() user: RequestUser) {
    return this.profiles.list(libraryId, dto, user);
  }

  @Get('profiles/:profileId')
  get(@Param('libraryId', ParseIntPipe) libraryId: number, @Param('profileId', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.profiles.get(libraryId, id, user);
  }

  @Post('profiles')
  create(@Param('libraryId', ParseIntPipe) libraryId: number, @Body() dto: CreateFanfictionProfileDto, @CurrentUser() user: RequestUser) {
    return this.profiles.create(libraryId, dto, user);
  }

  @Patch('profiles/:profileId')
  update(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('profileId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFanfictionProfileDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.profiles.update(libraryId, id, dto, user);
  }
}

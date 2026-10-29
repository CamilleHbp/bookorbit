import { BadRequestException, Body, Controller, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RequireLibraryAccess } from '../../common/decorators/require-library-access.decorator';
import type { RequestUser } from '../../common/types/request-user';
import type { MultipartRequest } from '../../common/types/multipart-request';
import { MANAGED_UPLOAD_MAX_BYTES } from '../book-dock/book-dock-managed-upload.service';
import { FanfictionReplacementService } from './fanfiction-replacement.service';
import { FanfictionJobService } from './fanfiction-job.service';
import { UploadFanfictionReplacementDto, ApproveFanfictionReplacementDto } from './dto/fanfiction-replacement.dto';

@Controller('libraries/:libraryId/fanfiction')
@RequirePermission(Permission.ManageLibraries)
@RequireLibraryAccess('owner')
export class FanfictionReplacementController {
  constructor(
    private readonly replacements: FanfictionReplacementService,
    private readonly jobs: FanfictionJobService,
  ) {}

  @Post('sources/:sourceId/replacement')
  @HttpCode(202)
  async upload(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @Query() dto: UploadFanfictionReplacementDto,
    @CurrentUser() user: RequestUser,
    @Req() request: MultipartRequest,
  ) {
    const file = await request.file({ limits: { files: 1, fields: 0, fileSize: MANAGED_UPLOAD_MAX_BYTES } });
    if (!file) throw new BadRequestException('Choose an EPUB replacement');
    return this.replacements.upload(libraryId, sourceId, dto, file.filename, file.file, user);
  }

  @Post('jobs/:jobId/approve-replacement')
  @HttpCode(202)
  approve(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() dto: ApproveFanfictionReplacementDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.jobs.approveReplacement(libraryId, jobId, dto.sha256, dto.expectedRevisionId, user);
  }
}

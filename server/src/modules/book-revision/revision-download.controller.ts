import { Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { RevisionDownloadApiService } from './revision-download-api.service';

@Controller('libraries/:libraryId/files/:fileId/revisions')
export class RevisionDownloadController {
  constructor(private readonly service: RevisionDownloadApiService) {}

  @Get(':revisionId/download')
  @RequirePermission(Permission.LibraryDownload)
  async download(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @CurrentUser() user: RequestUser,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.service.download(libraryId, fileId, revisionId, user, () => reply.raw.destroyed);
    reply.raw.once('close', () => result.stream.destroy());
    reply.header('Content-Type', 'application/epub+zip');
    reply.header('Content-Length', result.sizeBytes);
    reply.header('Cache-Control', 'private, no-store');
    reply.header('ETag', `"${result.sha256}"`);
    reply.header('X-BookOrbit-Revision', result.revisionId);
    reply.header('X-BookOrbit-SHA256', result.sha256);
    reply.send(result.stream);
  }
}

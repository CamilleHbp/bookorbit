import { Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { EpubRevisionService } from './epub-revision.service';

@Controller('epub/:bookId/files/:fileId')
export class EpubRevisionController {
  constructor(private readonly revisions: EpubRevisionService) {}

  @Get('revision')
  current(@Param('bookId', ParseIntPipe) bookId: number, @Param('fileId', ParseIntPipe) fileId: number, @CurrentUser() user: RequestUser) {
    return this.revisions.current(bookId, fileId, user);
  }

  @Get('revisions/:revisionId')
  async snapshot(
    @Param('bookId', ParseIntPipe) bookId: number,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @CurrentUser() user: RequestUser,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.revisions.snapshot(bookId, fileId, revisionId, user, () => reply.raw.destroyed);
    reply.raw.once('close', () => result.stream.destroy());
    reply.header('Content-Type', 'application/epub+zip');
    reply.header('Content-Length', result.sizeBytes);
    reply.header('X-BookOrbit-Revision', result.revisionId);
    reply.header('X-BookOrbit-SHA256', result.sha256);
    reply.header('Cache-Control', 'private, no-store');
    reply.send(result.stream);
  }
}

import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { FanfictionReaderService } from './fanfiction-reader.service';
@Controller('books/:bookId/files/:fileId/story')
export class FanfictionReaderController {
  constructor(private readonly stories: FanfictionReaderService) {}
  @Get()
  get(@Param('bookId', ParseIntPipe) bookId: number, @Param('fileId', ParseIntPipe) fileId: number, @CurrentUser() user: RequestUser) {
    return this.stories.forBook(bookId, fileId, user);
  }
}

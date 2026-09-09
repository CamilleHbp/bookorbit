import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { AcknowledgeReadingPositionDto, RecordReadingEventDto } from './dto/reading-event.dto';
import { ReadingEventApiService } from './reading-event-api.service';

@Controller('libraries/:libraryId/files/:fileId/reading-events')
export class ReadingEventController {
  constructor(private readonly service: ReadingEventApiService) {}

  @Get()
  state(@Param('libraryId', ParseIntPipe) libraryId: number, @Param('fileId', ParseIntPipe) fileId: number, @CurrentUser() user: RequestUser) {
    return this.service.state(libraryId, fileId, user);
  }

  @Post()
  @HttpCode(200)
  record(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Body() dto: RecordReadingEventDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.record(libraryId, fileId, dto, user);
  }

  @Post('acknowledgements')
  @HttpCode(200)
  acknowledge(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Body() dto: AcknowledgeReadingPositionDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.acknowledge(libraryId, fileId, dto, user);
  }
}

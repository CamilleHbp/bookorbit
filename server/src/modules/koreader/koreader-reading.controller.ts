import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { AcknowledgeReadingPositionDto, RecordReadingEventDto } from '../book-revision/dto/reading-event.dto';
import { KoreaderAuthGuard } from './koreader-auth.guard';
import { KoreaderReadingService } from './koreader-reading.service';

@Public()
@UseGuards(KoreaderAuthGuard)
@Controller('koreader/plugin/files/:fileId/reading-events')
export class KoreaderReadingController {
  constructor(private readonly reading: KoreaderReadingService) {}

  @Get()
  state(@Param('fileId', ParseIntPipe) fileId: number, @CurrentUser() user: RequestUser) {
    return this.reading.state(fileId, user);
  }

  @Post()
  record(@Param('fileId', ParseIntPipe) fileId: number, @Body() dto: RecordReadingEventDto, @CurrentUser() user: RequestUser) {
    return this.reading.record(fileId, dto, user);
  }

  @Post('acknowledgements')
  acknowledge(@Param('fileId', ParseIntPipe) fileId: number, @Body() dto: AcknowledgeReadingPositionDto, @CurrentUser() user: RequestUser) {
    return this.reading.acknowledge(fileId, dto, user);
  }
}

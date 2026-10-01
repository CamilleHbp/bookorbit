import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { FanfictionConnectionService } from './fanfiction-connection.service';
import { FanfictionSourceBatchService } from './fanfiction-source-batch.service';
import { RetryFanfictionConnectionDto, SaveFanfictionConnectionDto } from './dto/fanfiction-connection.dto';

@Controller('fanfiction/connections')
@RequirePermission(Permission.ManageLibraries)
export class FanfictionConnectionController {
  constructor(
    private readonly connections: FanfictionConnectionService,
    private readonly batches: FanfictionSourceBatchService,
  ) {}

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.connections.list(user);
  }

  @Get('websites')
  websites() {
    return this.connections.websites();
  }

  @Get('issues/:libraryId')
  issues(@Param('libraryId', ParseIntPipe) libraryId: number, @CurrentUser() user: RequestUser) {
    return this.connections.issues(libraryId, user);
  }

  @Get(':id/settings')
  settings(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.connections.settings(id, user);
  }

  @Post()
  @HttpCode(200)
  save(@Body() dto: SaveFanfictionConnectionDto, @CurrentUser() user: RequestUser) {
    return this.connections.save(dto, user);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.connections.remove(id, user);
  }

  @Post(':id/retry')
  @HttpCode(202)
  async retry(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RetryFanfictionConnectionDto, @CurrentUser() user: RequestUser) {
    const connection = await this.connections.owned(id, user);
    return this.batches.repairConnection(dto.libraryId, connection.site, user);
  }
}

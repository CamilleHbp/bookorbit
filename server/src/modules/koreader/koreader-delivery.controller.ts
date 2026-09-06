import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { KoreaderAuthGuard } from './koreader-auth.guard';
import { KoreaderDeliveryService } from './koreader-delivery.service';
import { KoreaderDeliveryExecutionService } from './koreader-delivery-execution.service';
import {
  RequestKoreaderDeliveryDto,
  ListKoreaderDeliveriesDto,
  ChangeKoreaderDeliveryDto,
  ClaimKoreaderDeliveryDto,
  KoreaderDeliveryLeaseDto,
  KoreaderDeliveryProgressDto,
} from './dto/koreader-delivery.dto';

@Controller('koreader/deliveries')
@RequirePermission(Permission.KoreaderSync)
export class KoreaderDeliveryController {
  constructor(private readonly deliveries: KoreaderDeliveryService) {}
  @Get()
  list(@Query() dto: ListKoreaderDeliveriesDto, @CurrentUser() user: RequestUser) {
    return this.deliveries.list(dto, user);
  }
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.deliveries.get(id, user);
  }
  @Post('copies/:id')
  @HttpCode(202)
  @RequirePermission(Permission.LibraryDownload, Permission.KoreaderSync)
  request(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RequestKoreaderDeliveryDto, @CurrentUser() user: RequestUser) {
    return this.deliveries.request(id, dto, user);
  }
  @Post(':id/cancel')
  @HttpCode(202)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeKoreaderDeliveryDto, @CurrentUser() user: RequestUser) {
    return this.deliveries.cancel(id, dto.version, user);
  }
  @Post(':id/retry')
  @HttpCode(202)
  @RequirePermission(Permission.LibraryDownload, Permission.KoreaderSync)
  retry(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeKoreaderDeliveryDto, @CurrentUser() user: RequestUser) {
    return this.deliveries.retry(id, dto.version, user);
  }
}

@Public()
@UseGuards(KoreaderAuthGuard)
@Controller('koreader/plugin/deliveries')
export class KoreaderPluginDeliveryController {
  constructor(
    private readonly deliveries: KoreaderDeliveryService,
    private readonly execution: KoreaderDeliveryExecutionService,
  ) {}
  @Get()
  list(@Query() dto: ListKoreaderDeliveriesDto, @CurrentUser() user: RequestUser) {
    return this.deliveries.list(dto, user);
  }
  @Post(':id/claim')
  @HttpCode(200)
  claim(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ClaimKoreaderDeliveryDto, @CurrentUser() user: RequestUser) {
    return this.execution.claim(id, dto, user);
  }
  @Post(':id/progress')
  @HttpCode(200)
  progress(@Param('id', ParseUUIDPipe) id: string, @Body() dto: KoreaderDeliveryProgressDto, @CurrentUser() user: RequestUser) {
    return this.execution.progress(id, dto, user);
  }
  @Post(':id/publication')
  @HttpCode(200)
  publication(@Param('id', ParseUUIDPipe) id: string, @Body() dto: KoreaderDeliveryLeaseDto, @CurrentUser() user: RequestUser) {
    return this.execution.authorizePublication(id, dto, user);
  }
  @Post(':id/download')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: KoreaderDeliveryLeaseDto,
    @CurrentUser() user: RequestUser,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.execution.download(id, dto, user, () => reply.raw.destroyed);
    reply.raw.once('close', () => result.stream.destroy());
    reply
      .code(200)
      .header('Content-Type', 'application/epub+zip')
      .header('Content-Length', result.sizeBytes)
      .header('Cache-Control', 'private, no-store')
      .header('ETag', `"${result.sha256}"`)
      .header('X-BookOrbit-Revision', result.revisionId)
      .header('X-BookOrbit-SHA256', result.sha256)
      .send(result.stream);
  }
}

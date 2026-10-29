import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { KoreaderAuthGuard } from './koreader-auth.guard';
import { KoreaderCopyService } from './koreader-copy.service';
import {
  KoreaderCopyInventoryDto,
  KoreaderCopyDeviceParamDto,
  ListKoreaderCopiesDto,
  ListKoreaderDeliveryDevicesDto,
  UpdateKoreaderCopyPolicyDto,
  UpdateKoreaderDevicePolicyDto,
  ListKoreaderPluginCopiesDto,
  KoreaderCopyPolicyAcknowledgementsDto,
} from './dto/koreader-copy.dto';

@Controller('koreader/copies')
@RequirePermission(Permission.KoreaderSync)
export class KoreaderCopiesController {
  constructor(private readonly copies: KoreaderCopyService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Query() query: ListKoreaderCopiesDto) {
    return this.copies.list(query, user);
  }

  @Get('devices')
  devices(@CurrentUser() user: RequestUser, @Query() query: ListKoreaderDeliveryDevicesDto) {
    return this.copies.listDevices(query, user);
  }

  @Patch('devices/:deviceId/policy')
  devicePolicy(@CurrentUser() user: RequestUser, @Param() params: KoreaderCopyDeviceParamDto, @Body() dto: UpdateKoreaderDevicePolicyDto) {
    return this.copies.updateDevicePolicy(params.deviceId, dto, user);
  }

  @Patch(':id/policy')
  copyPolicy(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateKoreaderCopyPolicyDto) {
    return this.copies.updateCopyPolicy(id, dto, user);
  }
}

@Public()
@UseGuards(KoreaderAuthGuard)
@RequirePermission(Permission.KoreaderSync)
@Controller('koreader/plugin/copies')
export class KoreaderPluginCopiesController {
  constructor(private readonly copies: KoreaderCopyService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Query() query: ListKoreaderPluginCopiesDto) {
    return this.copies.list(query, user);
  }

  @Post('policies/acknowledgements')
  @HttpCode(200)
  acknowledgePolicies(@CurrentUser() user: RequestUser, @Body() dto: KoreaderCopyPolicyAcknowledgementsDto) {
    return this.copies.acknowledgePolicies(dto, user);
  }

  @Post()
  @HttpCode(200)
  report(@CurrentUser() user: RequestUser, @Body() dto: KoreaderCopyInventoryDto) {
    return this.copies.report(dto, user);
  }
}

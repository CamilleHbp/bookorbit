import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import type { FanfictionJobKind } from '@bookorbit/types';
import { FanfictionPageDto } from './fanfiction.dto';

export class ListFanfictionJobsDto extends FanfictionPageDto {
  @IsOptional()
  @IsIn(['preview', 'discovery', 'adopt', 'import', 'update', 'refresh', 'rollback', 'source_batch', 'replacement'])
  kind?: FanfictionJobKind;
  @IsOptional() @IsIn(['true']) activeOnly?: 'true';
  @IsOptional() @IsIn(['true']) pendingImportsOnly?: 'true';
  @IsOptional() @IsIn(['true']) pendingDownloadsOnly?: 'true';
  @IsOptional() @IsUUID() sourceId?: string;
}

export class RetryFanfictionJobDto {
  @IsOptional() @IsBoolean() restart?: boolean;
}

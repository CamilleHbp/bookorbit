import { Type } from 'class-transformer';
import { IsBoolean, IsInt, Max, Min, Matches, IsIn, IsOptional, IsUUID } from 'class-validator';
import type { FanfictionDownloadSection, FanfictionJobKind } from '@bookorbit/types';
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

export class FanfictionDownloadsDto {
  @IsOptional() @IsIn(['running', 'queued', 'retrying', 'attention']) section?: FanfictionDownloadSection;
  @IsOptional() @Matches(/^[a-f0-9]{32}$/) group?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) offset = 0;
}

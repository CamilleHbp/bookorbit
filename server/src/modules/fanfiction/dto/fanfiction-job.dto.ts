import { IsIn, IsOptional, IsUUID } from 'class-validator';
import type { FanfictionJobKind } from '@bookorbit/types';
import { FanfictionPageDto } from './fanfiction.dto';

export class ListFanfictionJobsDto extends FanfictionPageDto {
  @IsOptional()
  @IsIn(['preview', 'discovery', 'adopt', 'import', 'update', 'refresh', 'rollback', 'source_batch', 'replacement'])
  kind?: FanfictionJobKind;
  @IsOptional() @IsIn(['true']) activeOnly?: 'true';
  @IsOptional() @IsUUID() sourceId?: string;
}

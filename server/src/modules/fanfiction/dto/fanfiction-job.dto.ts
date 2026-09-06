import { IsIn, IsOptional, IsUUID } from 'class-validator';
import type { FanfictionJobKind } from '@bookorbit/types';
import { ListFanfictionProfilesDto } from './fanfiction-profile.dto';

export class ListFanfictionJobsDto extends ListFanfictionProfilesDto {
  @IsOptional()
  @IsIn(['preview', 'discovery', 'adopt', 'import', 'update', 'refresh', 'rollback', 'source_batch', 'replacement'])
  kind?: FanfictionJobKind;
  @IsOptional() @IsIn(['true']) activeOnly?: 'true';
  @IsOptional() @IsUUID() sourceId?: string;
}

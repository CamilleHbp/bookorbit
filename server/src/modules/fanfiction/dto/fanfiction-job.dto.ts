import { IsIn, IsOptional } from 'class-validator';
import type { FanfictionJobKind } from '@bookorbit/types';
import { ListFanfictionProfilesDto } from './fanfiction-profile.dto';

export class ListFanfictionJobsDto extends ListFanfictionProfilesDto {
  @IsOptional() @IsIn(['preview', 'discovery', 'adopt', 'import', 'update', 'refresh', 'rollback']) kind?: FanfictionJobKind;
  @IsOptional() @IsIn(['true']) activeOnly?: 'true';
}

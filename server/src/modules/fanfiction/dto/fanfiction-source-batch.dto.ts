import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { FanfictionSourceBatchAction, FanfictionSourceState } from '@bookorbit/types';

export class SelectFanfictionSourcesDto {
  @IsUUID() idempotencyKey!: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID(undefined, { each: true }) ids?: string[];
  @IsOptional() @IsBoolean() allMatching?: boolean;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsIn(['pending', 'active', 'paused', 'review_required', 'configuration_blocked', 'unlinked']) state?: FanfictionSourceState;
  @IsIn(['update', 'refresh', 'retry', 'schedule']) action!: FanfictionSourceBatchAction;
  @IsOptional() @IsInt() @Min(60) @Max(525600) intervalMinutes?: number | null;
}

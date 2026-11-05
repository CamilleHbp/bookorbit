import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { FanfictionActivityKind } from '@bookorbit/types';

export class FanfictionPreferencesDto {
  @IsOptional() @IsBoolean() isAdult?: boolean;
  @IsOptional() @IsIn(['safe', 'review']) defaultUpdatePolicy?: 'safe' | 'review';
}

export class FanfictionCookieDto {
  @IsString() @MinLength(1) @MaxLength(256) @Matches(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/) name!: string;
  @IsString() @MaxLength(4096) @Matches(/^[\x20-\x7e]*$/) value!: string;
  @IsString() @MinLength(1) @MaxLength(255) @Matches(/^\.?[a-zA-Z0-9.-]+$/) domain!: string;
  @IsString() @MaxLength(4096) @Matches(/^\/[^\p{Cc}]*$/u) path!: string;
  @IsBoolean() secure!: boolean;
  @IsOptional() @IsBoolean() hostOnly?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expires?: number;
}

export class FanfictionTagRuleDto {
  @IsString() @MinLength(1) @MaxLength(500) @Matches(/\S/) remoteTag!: string;
  @IsString() @MinLength(1) @MaxLength(500) @Matches(/\S/) targetTag!: string;
}

export class FanfictionPageDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}

export class ListFanfictionActivityDto extends FanfictionPageDto {
  @IsOptional() @IsIn(['imported', 'updated', 'rolled_back', 'attention', 'failed', 'batch_completed']) kind?: FanfictionActivityKind;
}

export class FanfictionActivitySummaryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) days = 7;
}

export class PreviewFanfictionDto {
  @IsString() @MaxLength(4096) @Matches(/^https:\/\/[^\s]+$/) url!: string;
  @IsUUID() idempotencyKey!: string;
}

export class FanfictionLibrariesDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) cursor = 0;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}

export class FanfictionJobsStatusDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID(undefined, { each: true }) ids!: string[];
}

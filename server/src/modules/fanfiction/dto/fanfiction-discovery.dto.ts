import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { FanfictionCandidateState } from '@bookorbit/types';

export class StartFanfictionDiscoveryDto {
  @IsUUID() idempotencyKey!: string;
}

export class ListFanfictionWebsitesDto {
  @IsOptional() @IsString() @MaxLength(253) website?: string;
  @IsOptional() @IsString() @MaxLength(253) cursor?: string;
  @IsOptional() @IsDateString() cutoff?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}

export class CompareFanfictionDiscoveryDto {
  @IsOptional() @IsUUID() profileId?: string | null;
  @IsOptional() @IsBoolean() autoProfile?: boolean;
  @IsOptional() @IsString() @MaxLength(4096) canonicalUrl?: string;
}

export class ListFanfictionDiscoveryDto {
  @IsOptional() @IsString() @MaxLength(253) website?: string;
  @IsOptional() @IsIn(['true']) review?: string;
  @IsOptional() @IsDateString() cutoff?: string;
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',') : value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  ids?: string[];
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.split('\n') : value))
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(4096, { each: true })
  urlPrefixes?: string[];
  @IsOptional() @IsUUID() cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @IsIn(['pending', 'ambiguous', 'rejected', 'linked', 'failed']) state: FanfictionCandidateState = 'pending';
}

export class FanfictionDiscoveryOverrideDto {
  @IsUUID() id!: string;
  @IsOptional() @IsUUID() profileId?: string | null;
  @IsOptional() @IsString() @MaxLength(4096) canonicalUrl?: string;
}

export class SelectFanfictionDiscoveryDto {
  @IsOptional() @IsString() @MaxLength(253) website?: string;
  @IsOptional() @IsBoolean() review?: boolean;
  @IsOptional() @IsDateString() cutoff?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsUUID(undefined, { each: true }) excludedIds?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => FanfictionDiscoveryOverrideDto)
  overrides?: FanfictionDiscoveryOverrideDto[];
  @IsOptional() @IsBoolean() autoProfile?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(4096, { each: true }) urlPrefixes?: string[];
  @IsUUID() idempotencyKey!: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID(undefined, { each: true }) ids?: string[];
  @IsOptional() @IsBoolean() allMatching?: boolean;
  @IsIn(['pending', 'ambiguous', 'failed']) state: FanfictionCandidateState = 'pending';
  @IsIn(['approve', 'reject']) decision!: 'approve' | 'reject';
  @IsOptional() @IsUUID() profileId?: string | null;
  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined) @IsInt() @Min(60) @Max(525600) intervalMinutes?: number | null;
  @IsOptional() @IsString() @MaxLength(4096) canonicalUrl?: string;
}

export class PreviewStoryLinkDto {
  @IsOptional() @IsUUID() profileId?: string;
  @IsInt() @Min(1) bookId!: number;
  @IsInt() @Min(1) bookFileId!: number;
  @IsString() @MaxLength(4096) url!: string;
}

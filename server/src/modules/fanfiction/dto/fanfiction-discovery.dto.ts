import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import type { FanfictionCandidateState } from '@bookorbit/types';

export class StartFanfictionDiscoveryDto {
  @IsUUID() idempotencyKey!: string;
}

export class ListFanfictionDiscoveryDto {
  @IsOptional() @IsUUID() cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @IsIn(['pending', 'ambiguous', 'rejected', 'linked', 'failed']) state: FanfictionCandidateState = 'pending';
}

export class SelectFanfictionDiscoveryDto {
  @IsUUID() idempotencyKey!: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID(undefined, { each: true }) ids?: string[];
  @IsOptional() @IsBoolean() allMatching?: boolean;
  @IsIn(['pending', 'ambiguous', 'failed']) state: FanfictionCandidateState = 'pending';
  @IsIn(['approve', 'reject']) decision!: 'approve' | 'reject';
  @IsOptional() @IsUUID() profileId?: string | null;
  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined) @IsInt() @Min(60) @Max(525600) intervalMinutes?: number | null;
  @IsOptional() @IsString() @MaxLength(4096) canonicalUrl?: string;
}

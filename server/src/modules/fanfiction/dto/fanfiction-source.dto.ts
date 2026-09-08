import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  IsObject,
  ValidateNested,
} from 'class-validator';
import type { FanfictionImportRequest, FanfictionSourceState } from '@bookorbit/types';
import { PreviewFanfictionDto } from './fanfiction-profile.dto';

export class FanfictionMetadataEditsDto {
  @ValidateIf((_object, value) => value !== undefined) @IsString() @MaxLength(500) @Matches(/\S/) title?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  @Matches(/\S/, { each: true })
  authors?: string[];
  @ValidateIf((_object, value) => value !== undefined) @IsString() @MaxLength(65536) description?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  @Matches(/\S/, { each: true })
  tags?: string[];
}

export class ImportFanfictionDto extends PreviewFanfictionDto implements FanfictionImportRequest {
  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => FanfictionMetadataEditsDto)
  metadata?: FanfictionMetadataEditsDto;
  @IsInt() @Min(1) folderId!: number;
  @IsOptional() @IsInt() @Min(60) @Max(525600) intervalMinutes?: number | null;
}

export class CheckFanfictionSourceDto {
  @IsUUID() idempotencyKey!: string;
  @IsIn(['update', 'refresh']) kind!: 'update' | 'refresh';
}

export class RollbackFanfictionSourceDto {
  @IsUUID() idempotencyKey!: string;
  @IsUUID() revisionId!: string;
  @IsUUID() expectedRevisionId!: string;
}

export class ListFanfictionSourcesDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) bookId?: number;
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsIn(['pending', 'active', 'paused', 'review_required', 'configuration_blocked', 'unlinked']) state?: FanfictionSourceState;
}

export class UpdateFanfictionSourceDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsUUID() profileId?: string | null;
  @IsOptional() @IsInt() @Min(60) @Max(525600) intervalMinutes?: number | null;
  @IsOptional() @IsIn(['active', 'paused', 'unlinked']) state?: 'active' | 'paused' | 'unlinked';
}

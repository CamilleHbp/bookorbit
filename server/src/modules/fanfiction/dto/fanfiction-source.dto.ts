import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { FanfictionImportRequest, FanfictionSourceState, FanfictionMetadataResolution } from '@bookorbit/types';
import { PreviewFanfictionDto } from './fanfiction-profile.dto';

export class ImportFanfictionDto extends PreviewFanfictionDto implements FanfictionImportRequest {
  @IsOptional() @IsInt() @Min(1) collectionId?: number;
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

export class StoryMetadataValuesDto {
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsString({ each: true }) @MaxLength(500, { each: true }) genres?: string[];
  @IsString() @MinLength(1) @MaxLength(500) title!: string;
  @IsString() @MaxLength(262144) description!: string;
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(500, { each: true }) authors!: string[];
  @IsArray() @ArrayMaxSize(1000) @IsString({ each: true }) @MaxLength(500, { each: true }) tags!: string[];
}
export class ResolveFanfictionMetadataDto implements FanfictionMetadataResolution {
  @IsUUID() jobId!: string;
  @IsString() @MaxLength(64) fingerprint!: string;
  @IsIn(['keep', 'incoming', 'edit']) title!: 'keep' | 'incoming' | 'edit';
  @IsIn(['keep', 'incoming', 'edit']) description!: 'keep' | 'incoming' | 'edit';
  @IsIn(['keep', 'incoming', 'edit']) authors!: 'keep' | 'incoming' | 'edit';
  @IsOptional() @IsIn(['keep', 'incoming', 'edit']) genres?: 'keep' | 'incoming' | 'edit';
  @IsOptional() @IsBoolean() keepAll?: boolean;
  @IsOptional() @ValidateNested() @Type(() => StoryMetadataValuesDto) values?: StoryMetadataValuesDto;
  @IsIn(['keep', 'merge', 'select']) tags!: 'keep' | 'merge' | 'select';
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsString({ each: true }) @MaxLength(500, { each: true }) selectedTags?: string[];
}

export class ImportStoryReviewDto {
  @IsIn(['apply', 'later', 'discard']) action!: 'apply' | 'later' | 'discard';
  @IsOptional() @ValidateNested() @Type(() => StoryMetadataValuesDto) values?: StoryMetadataValuesDto;
}

export class ListFanfictionSourcesDto {
  @IsOptional() @IsIn(['ongoing', 'complete']) publication?: 'ongoing' | 'complete';
  @IsOptional() @IsIn(['added', 'updated']) sort?: 'added' | 'updated';
  @IsOptional() @IsString() @MaxLength(200) tag?: string;
  @IsOptional() @IsString() @MaxLength(200) genre?: string;
  @IsOptional() @IsString() @MaxLength(500) fandom?: string;
  @IsOptional() @IsIn(['attention', 'new', 'unread']) view?: 'attention' | 'new' | 'unread';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) bookId?: number;
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsIn(['pending', 'active', 'paused', 'review_required', 'configuration_blocked', 'unlinked']) state?: FanfictionSourceState;
}

export class UpdateFanfictionSourceDto {
  @IsOptional() @IsIn(['review', 'automatic']) tagPolicy?: 'review' | 'automatic';
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsUUID() profileId?: string | null;
  @IsOptional() @IsInt() @Min(60) @Max(525600) intervalMinutes?: number | null;
  @IsOptional() @IsIn(['active', 'paused', 'unlinked']) state?: 'active' | 'paused' | 'unlinked';
}

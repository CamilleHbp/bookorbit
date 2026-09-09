import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { FanfictionImportRequest, FanfictionSourceState, FanfictionMetadataResolution } from '@bookorbit/types';
import { PreviewFanfictionDto } from './fanfiction-profile.dto';

export class ImportFanfictionDto extends PreviewFanfictionDto implements FanfictionImportRequest {
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

export class ResolveFanfictionMetadataDto implements FanfictionMetadataResolution {
  @IsUUID() jobId!: string;
  @IsString() @MaxLength(64) fingerprint!: string;
  @IsIn(['keep', 'incoming']) title!: 'keep' | 'incoming';
  @IsIn(['keep', 'incoming']) description!: 'keep' | 'incoming';
  @IsIn(['keep', 'incoming']) authors!: 'keep' | 'incoming';
  @IsIn(['keep', 'merge']) tags!: 'keep' | 'merge';
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

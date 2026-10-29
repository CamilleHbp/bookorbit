import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { ReadingAnchor, ReadingEventIdentity } from '@bookorbit/types';

export class NativeLocatorDto {
  @IsIn(['cfi', 'xpointer'])
  kind!: 'cfi' | 'xpointer';

  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  value!: string;
}

export class ReadingEventIdentityDto implements ReadingEventIdentity {
  @IsUUID()
  id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  deviceId!: string;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  deviceSequence!: number;

  @IsISO8601({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  @MaxLength(40)
  occurredAt!: string;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  resetGeneration!: number;
}

export class ReadingAnchorDto implements ReadingAnchor {
  @IsOptional()
  @IsIn([1])
  schemaVersion?: 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  bookId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  bookFileId?: number;

  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  provisionalSha256?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => NativeLocatorDto)
  nativeLocator?: NativeLocatorDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ReadingEventIdentityDto)
  event?: ReadingEventIdentityDto;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  revision!: string;

  @IsInt()
  @Min(0)
  @Max(100_000)
  chapterIndex!: number;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  chapterHref?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  chapterTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  chapterSourceUrl?: string;

  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  chapterTextHash?: string;

  @IsNumber()
  @Min(0)
  @Max(1)
  chapterFraction!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  bookFraction!: number;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  quote?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  prefix?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  suffix?: string;
}

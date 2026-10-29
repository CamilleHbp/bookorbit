import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import type { BrowseTagsParams } from '@bookorbit/types';
export class BrowseTagsDto implements BrowseTagsParams {
  @IsOptional() @IsString() @MaxLength(500) search?: string;
  @IsOptional() @IsString() @Length(1, 8) @Matches(/^[^\s\p{Cc}]+$/u) tagSeparator?: string;
  @IsOptional() @IsString() @MaxLength(500) tagPrefix?: string;
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(1000000) page?: number;
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

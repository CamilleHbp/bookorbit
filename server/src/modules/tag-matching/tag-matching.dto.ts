import { Type, Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import type { LabelField } from '@bookorbit/types';
const labelFields = ['tags', 'genres', 'fandoms', 'characters', 'relationships', 'warnings', 'rating'];
export class MatchingPageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsString() @MaxLength(200) source?: string;
  @IsOptional() @IsIn(labelFields) field?: LabelField;
  @IsOptional() @IsIn(['match', 'ignore']) action?: 'match' | 'ignore';
}
export class MatchingTargetDto {
  @IsIn(['tags', 'genres']) field!: 'tags' | 'genres';
  @IsInt() @Min(1) id!: number;
}
export class MatchingNewTargetDto {
  @IsIn(['tags', 'genres']) field!: 'tags' | 'genres';
  @IsString() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @MinLength(1) @MaxLength(200) name!: string;
}
export class SaveMatchingRuleDto {
  @IsOptional() @IsUUID() id?: string;
  @IsInt() @Min(1) version!: number;
  @IsString() @MaxLength(200) source = '';
  @IsIn(labelFields) field!: LabelField;
  @IsString() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @MinLength(1) @MaxLength(500) value!: string;
  @IsIn(['match', 'ignore']) action!: 'match' | 'ignore';
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => MatchingTargetDto) targets!: MatchingTargetDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => MatchingNewTargetDto) newTargets?: MatchingNewTargetDto[];
}
export class MatchingVersionDto {
  @IsInt() @Min(1) version!: number;
}
export class MatchingLibraryDto {
  @IsInt() @Min(1) libraryId!: number;
}
export class MatchingSuggestionsDto {
  @IsString() @MinLength(1) @MaxLength(500) search!: string;
  @IsOptional() @IsIn(['tags', 'genres']) field?: 'tags' | 'genres';
}

export class MatchingPreviewDto {
  @IsArray() @ArrayMaxSize(2) @IsIn(['tags', 'genres'], { each: true }) overrideFields: Array<'tags' | 'genres'> = [];
}

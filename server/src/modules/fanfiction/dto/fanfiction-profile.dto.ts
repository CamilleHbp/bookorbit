import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsInt,
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

export class FanfictionCookieDto {
  @IsString() @MinLength(1) @MaxLength(256) @Matches(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/) name!: string;
  @IsString() @MaxLength(4096) @Matches(/^[\x20-\x7e]*$/) value!: string;
  @IsString() @MinLength(1) @MaxLength(255) @Matches(/^\.?[a-zA-Z0-9.-]+$/) domain!: string;
  @IsString() @MaxLength(4096) @Matches(/^\/[^\r\n]*$/) path!: string;
  @IsBoolean() secure!: boolean;
  @IsOptional() @IsInt() @Min(0) expires?: number;
}

export class FanfictionCredentialsDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(255) @Matches(/^[^\r\n[\]]+$/) section?: string;
  @IsOptional() @IsString() @MaxLength(4096) username?: string;
  @IsOptional() @IsString() @MaxLength(4096) password?: string;
  @IsOptional() @IsBoolean() isAdult?: boolean;
}

export class CreateFanfictionProfileDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(65536) configuration?: string;
  @IsOptional() @ValidateNested() @Type(() => FanfictionCredentialsDto) credentials?: FanfictionCredentialsDto;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => FanfictionCookieDto) cookies?: FanfictionCookieDto[];
}

export class UpdateFanfictionProfileDto extends CreateFanfictionProfileDto {
  @IsDefined() @IsInt() @Min(1) version!: number;
}

export class ListFanfictionProfilesDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}

export class PreviewFanfictionDto {
  @IsString() @MaxLength(4096) @Matches(/^https:\/\/[^\s]+$/) url!: string;
  @IsOptional() @IsUUID() profileId?: string;
  @IsUUID() idempotencyKey!: string;
}

export class FanfictionLibrariesDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) cursor = 0;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}

export class FanfictionJobsStatusDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID(undefined, { each: true }) ids!: string[];
}

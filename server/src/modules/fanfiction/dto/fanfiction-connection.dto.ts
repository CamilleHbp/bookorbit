import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { FanfictionCookieDto } from './fanfiction-profile.dto';

export class SaveFanfictionConnectionDto {
  @IsString() @MinLength(1) @MaxLength(255) site!: string;
  @IsOptional() @IsInt() @Min(1) version?: number;
  @IsOptional() @IsString() @MaxLength(4096) username?: string;
  @IsOptional() @IsString() @MaxLength(4096) password?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => FanfictionCookieDto) cookies?: FanfictionCookieDto[];
}

export class RetryFanfictionConnectionDto {
  @IsInt() @Min(1) libraryId!: number;
}

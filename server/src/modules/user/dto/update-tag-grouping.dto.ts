import { IsBoolean, IsString, Length, Matches } from 'class-validator';
import { MAX_TAG_SEPARATOR_LENGTH, type TagGroupingPreferences } from '@bookorbit/types';

export class UpdateTagGroupingDto implements TagGroupingPreferences {
  @IsBoolean()
  enabled!: boolean;

  @IsString()
  @Length(1, MAX_TAG_SEPARATOR_LENGTH)
  @Matches(/^[^\s\p{Cc}]+$/u)
  separator!: string;
}

import { Type } from 'class-transformer';
import { IsDefined, IsInt, IsOptional, IsUUID, Max, Min, ValidateNested } from 'class-validator';
import { ReadingAnchorDto } from '../../../common/dto/reading-anchor.dto';
export { ReadingAnchorDto, NativeLocatorDto, ReadingEventIdentityDto } from '../../../common/dto/reading-anchor.dto';

export class ResolveReadingAnchorDto {
  @IsUUID()
  targetRevisionId!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => ReadingAnchorDto)
  anchor!: ReadingAnchorDto;
}

export class ListRevisionsDto {
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

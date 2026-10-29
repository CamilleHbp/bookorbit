import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsInt, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import type { PositionResolutionQuality, RecordReadingEventRequest, RevisionPositionAcknowledgement } from '@bookorbit/types';
import { NativeLocatorDto, ReadingAnchorDto } from './reading-anchor.dto';

export class RecordReadingEventDto implements RecordReadingEventRequest {
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedUserId?: number;

  @IsDefined()
  @ValidateNested()
  @Type(() => ReadingAnchorDto)
  anchor!: ReadingAnchorDto;
}

export class PositionAcknowledgementDto implements RevisionPositionAcknowledgement {
  @IsUUID()
  eventId!: string;

  @Matches(/^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|sha256:[a-f0-9]{64})$/i)
  revision!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => NativeLocatorDto)
  nativeLocator!: NativeLocatorDto;

  @IsIn(['exact', 'relocated', 'approximate'])
  quality!: PositionResolutionQuality;
}

export class AcknowledgeReadingPositionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  deviceId!: string;

  @IsUUID()
  copyId!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => PositionAcknowledgementDto)
  acknowledgement!: PositionAcknowledgementDto;
}

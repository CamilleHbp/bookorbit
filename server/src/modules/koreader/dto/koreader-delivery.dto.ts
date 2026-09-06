import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type {
  ClaimKoreaderDelivery,
  KoreaderDeliveryFailure,
  KoreaderDeliveryLeaseIdentity,
  KoreaderDeliveryProgress,
  RequestKoreaderDelivery,
} from '@bookorbit/types';

export class RequestKoreaderDeliveryDto implements RequestKoreaderDelivery {
  @IsUUID() idempotencyKey!: string;
  @IsUUID() expectedRevisionId!: string;
}
export class ListKoreaderDeliveriesDto {
  @IsOptional() @IsIn(['true']) activeOnly?: 'true';
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @IsOptional() @IsUUID() installedCopyId?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) deviceId?: string;
}
export class ChangeKoreaderDeliveryDto {
  @IsInt() @Min(1) version!: number;
}
export class ClaimKoreaderDeliveryDto implements ClaimKoreaderDelivery {
  @IsString() @MinLength(1) @MaxLength(100) deviceId!: string;
  @IsUUID() claimId!: string;
}
export class KoreaderDeliveryLeaseDto implements KoreaderDeliveryLeaseIdentity {
  @IsString() @MinLength(1) @MaxLength(100) deviceId!: string;
  @IsUUID() token!: string;
  @IsInt() @Min(1) fence!: number;
}
export class KoreaderDeliveryProgressDto extends KoreaderDeliveryLeaseDto implements KoreaderDeliveryProgress {
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) sequence!: number;
  @IsIn(['waiting_for_uploads', 'waiting_for_close', 'downloading', 'installed']) state!: KoreaderDeliveryProgress['state'];
  @Matches(/^[a-f0-9]{64}$/) localSha256!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) localSizeBytes!: number;
  @IsString() @MinLength(1) @MaxLength(4096) @Matches(/^[^\p{Cc}]+$/u) pathname!: string;
  @IsBoolean() readingUploadsComplete!: boolean;
  @IsOptional() @IsUUID() publicationToken?: string;
  @IsOptional()
  @IsIn(['upload_failed', 'download_failed', 'verification_failed', 'publication_failed', 'configuration_blocked'])
  failureCode?: KoreaderDeliveryFailure;
}

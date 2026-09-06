import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDefined,
  IsIn,
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
import type {
  KoreaderCopyInventoryRequest,
  KoreaderInstalledCopyReport,
  KoreaderDeliveryPolicy,
  KoreaderCopyPolicyUpdate,
  KoreaderDevicePolicyUpdate,
} from '@bookorbit/types';

export class KoreaderInstalledCopyReportDto implements KoreaderInstalledCopyReport {
  @IsUUID() copyId!: string;
  @IsInt() @Min(1) bookFileId!: number;
  @IsString() @MinLength(1) @MaxLength(4096) @Matches(/^[^\p{Cc}]+$/u) pathname!: string;
  @Matches(/^[a-f0-9]{64}$/) sha256!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) sizeBytes!: number;
  @IsOptional() @IsUUID() revisionId?: string | null;
  @IsOptional() @Matches(/^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$/) policyAcknowledgement?: string;
}

export class KoreaderCopyInventoryDto implements KoreaderCopyInventoryRequest {
  @IsIn([1]) protocolVersion!: 1;
  @IsString() @MinLength(1) @MaxLength(100) deviceId!: string;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) sequence!: number;
  @IsString() @MinLength(1) @MaxLength(64) pluginVersion!: string;
  @IsInt() @Min(0) @Max(100) deliveryCapabilityVersion!: number;
  @IsInt() @Min(0) @Max(100) positionCapabilityVersion!: number;
  @IsDefined()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique((copy: KoreaderInstalledCopyReportDto | null) => copy?.copyId)
  @ValidateNested({ each: true })
  @Type(() => KoreaderInstalledCopyReportDto)
  copies!: KoreaderInstalledCopyReportDto[];
}

export class ListKoreaderCopiesDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) deviceId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) bookFileId?: number;
}

export class UpdateKoreaderCopyPolicyDto implements KoreaderCopyPolicyUpdate {
  @IsInt() @Min(1) version!: number;
  @IsIn(['notify', 'automatic', 'ignore', null]) policy!: KoreaderDeliveryPolicy | null;
}

export class ListKoreaderDeliveryDevicesDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}

export class UpdateKoreaderDevicePolicyDto implements KoreaderDevicePolicyUpdate {
  @IsInt() @Min(1) version!: number;
  @IsIn(['notify', 'automatic', 'ignore']) policy!: KoreaderDeliveryPolicy;
}

export class KoreaderCopyDeviceParamDto {
  @IsString() @MinLength(1) @MaxLength(100) deviceId!: string;
}

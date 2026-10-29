import { IsUUID, Matches } from 'class-validator';

export class UploadFanfictionReplacementDto {
  @IsUUID() idempotencyKey!: string;
  @IsUUID() expectedRevisionId!: string;
}

export class ApproveFanfictionReplacementDto {
  @Matches(/^[a-f0-9]{64}$/) sha256!: string;
  @IsUUID() expectedRevisionId!: string;
}

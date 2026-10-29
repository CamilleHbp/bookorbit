import type { UpdateSensitiveCoverRequest } from '@bookorbit/types';
import { IsBoolean } from 'class-validator';

export class UpdateSensitiveCoverDto implements UpdateSensitiveCoverRequest {
  @IsBoolean()
  sensitiveCover: boolean;
}

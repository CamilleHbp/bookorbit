import { Module } from '@nestjs/common';
import { FanfictionLocationService } from './fanfiction-location.service';

@Module({ providers: [FanfictionLocationService], exports: [FanfictionLocationService] })
export class FanfictionLocationModule {}

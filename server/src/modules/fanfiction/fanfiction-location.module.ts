import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { fanficfareConfig, storageConfig } from '../../config/config';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { FanfictionLocationService } from './fanfiction-location.service';

@Module({
  imports: [ConfigModule.forFeature(fanficfareConfig), ConfigModule.forFeature(storageConfig)],
  providers: [FanficfareRuntimeService, FanfictionLocationService],
  exports: [FanficfareRuntimeService, FanfictionLocationService],
})
export class FanfictionLocationModule {}

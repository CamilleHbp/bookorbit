import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { fanficfareConfig, storageConfig } from '../../config/config';
import { LibraryModule } from '../library/library.module';
import { UserModule } from '../user/user.module';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { FanfictionVaultService } from './fanfiction-vault.service';
import { FanfictionProfileService } from './fanfiction-profile.service';
import { FanfictionController } from './fanfiction.controller';
import { FanfictionJobService } from './fanfiction-job.service';
import { FanfictionWorkerService } from './fanfiction-worker.service';
import { FanfictionLibraryController } from './fanfiction-library.controller';

@Module({
  imports: [ConfigModule.forFeature(fanficfareConfig), ConfigModule.forFeature(storageConfig), LibraryModule, UserModule],
  providers: [
    FanfictionAccessService,
    FanficfareRuntimeService,
    FanfictionVaultService,
    FanfictionProfileService,
    FanfictionJobService,
    FanfictionWorkerService,
  ],
  controllers: [FanfictionController, FanfictionLibraryController],
})
export class FanfictionModule {}

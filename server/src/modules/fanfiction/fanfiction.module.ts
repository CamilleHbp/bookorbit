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
import { AppSettingsModule } from '../app-settings/app-settings.module';
import { UploadModule } from '../upload/upload.module';
import { BookDockModule } from '../book-dock/book-dock.module';
import { BookRevisionModule } from '../book-revision/book-revision.module';
import { FanfictionSourceService } from './fanfiction-source.service';
import { FanfictionSourceController } from './fanfiction-source.controller';
import { FanfictionImportService } from './fanfiction-import.service';

@Module({
  imports: [
    ConfigModule.forFeature(fanficfareConfig),
    ConfigModule.forFeature(storageConfig),
    LibraryModule,
    UserModule,
    AppSettingsModule,
    UploadModule,
    BookDockModule,
    BookRevisionModule,
  ],
  providers: [
    FanfictionAccessService,
    FanficfareRuntimeService,
    FanfictionVaultService,
    FanfictionProfileService,
    FanfictionJobService,
    FanfictionWorkerService,
    FanfictionSourceService,
    FanfictionImportService,
  ],
  controllers: [FanfictionController, FanfictionLibraryController, FanfictionSourceController],
})
export class FanfictionModule {}

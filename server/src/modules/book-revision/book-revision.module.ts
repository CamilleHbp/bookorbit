import { RevisionCoordinationService } from './revision-coordination.service';
import { KoboFileStateModule } from '../kobo/kobo-file-state.module';
import { ConfigModule } from '@nestjs/config';
import { storageConfig } from '../../config/config';
import { RevisionMetadataService } from './revision-metadata.service';
import { RevisionDownloadService } from './revision-download.service';
import { CanonicalReadingService } from './canonical-reading.service';
import { Module } from '@nestjs/common';
import { FileLockModule } from '../../common/file-lock.module';
import { BookRevisionService } from './book-revision.service';

import { RevisionPublicationService } from './revision-publication.service';

import { RevisionCatalogService } from './revision-catalog.service';
import { BookProgressModule } from '../book/book-progress.module';
import { RevisionFileModule } from './revision-file.module';
import { RevisionInterruptionService } from './revision-interruption.service';
import { RevisionRetentionService } from './revision-retention.service';

@Module({
  imports: [KoboFileStateModule, FileLockModule, ConfigModule.forFeature(storageConfig), BookProgressModule, RevisionFileModule],
  providers: [
    BookRevisionService,
    RevisionCoordinationService,
    RevisionMetadataService,
    RevisionPublicationService,
    RevisionInterruptionService,
    RevisionRetentionService,
    RevisionCatalogService,
    CanonicalReadingService,
    RevisionDownloadService,
  ],
  exports: [
    BookRevisionService,
    RevisionCoordinationService,
    RevisionMetadataService,
    RevisionFileModule,
    RevisionPublicationService,
    RevisionInterruptionService,
    RevisionCatalogService,
    CanonicalReadingService,
    RevisionDownloadService,
  ],
})
export class BookRevisionModule {}

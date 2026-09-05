import { ConfigModule } from '@nestjs/config';
import { storageConfig } from '../../config/config';
import { RevisionDownloadService } from './revision-download.service';
import { CanonicalReadingService } from './canonical-reading.service';
import { Module } from '@nestjs/common';
import { FileLockModule } from '../../common/file-lock.module';
import { BookRevisionService } from './book-revision.service';

import { RevisionPublicationService } from './revision-publication.service';

import { RevisionCatalogService } from './revision-catalog.service';
import { BookProgressModule } from '../book/book-progress.module';
import { RevisionFileModule } from './revision-file.module';

@Module({
  imports: [FileLockModule, ConfigModule.forFeature(storageConfig), BookProgressModule, RevisionFileModule],
  providers: [BookRevisionService, RevisionPublicationService, RevisionCatalogService, CanonicalReadingService, RevisionDownloadService],
  exports: [
    BookRevisionService,
    RevisionFileModule,
    RevisionPublicationService,
    RevisionCatalogService,
    CanonicalReadingService,
    RevisionDownloadService,
  ],
})
export class BookRevisionModule {}

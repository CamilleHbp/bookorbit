import { ConfigModule } from '@nestjs/config';
import { storageConfig } from '../../config/config';
import { RevisionDownloadService } from './revision-download.service';
import { CanonicalReadingService } from './canonical-reading.service';
import { Module } from '@nestjs/common';
import { FileLockModule } from '../../common/file-lock.module';
import { BookRevisionService } from './book-revision.service';
import { EpubManifestService } from './epub-manifest.service';

import { RevisionPublicationService } from './revision-publication.service';

import { RevisionCatalogService } from './revision-catalog.service';

@Module({
  imports: [FileLockModule, ConfigModule.forFeature(storageConfig)],
  providers: [
    BookRevisionService,
    EpubManifestService,
    RevisionPublicationService,
    RevisionCatalogService,
    CanonicalReadingService,
    RevisionDownloadService,
  ],
  exports: [
    BookRevisionService,
    EpubManifestService,
    RevisionPublicationService,
    RevisionCatalogService,
    CanonicalReadingService,
    RevisionDownloadService,
  ],
})
export class BookRevisionModule {}

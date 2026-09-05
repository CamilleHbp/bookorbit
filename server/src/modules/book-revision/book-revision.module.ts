import { CanonicalReadingService } from './canonical-reading.service';
import { Module } from '@nestjs/common';
import { FileLockModule } from '../../common/file-lock.module';
import { BookRevisionService } from './book-revision.service';
import { EpubManifestService } from './epub-manifest.service';

import { RevisionPublicationService } from './revision-publication.service';

import { RevisionCatalogService } from './revision-catalog.service';

@Module({
  imports: [FileLockModule],
  providers: [BookRevisionService, EpubManifestService, RevisionPublicationService, RevisionCatalogService, CanonicalReadingService],
  exports: [BookRevisionService, EpubManifestService, RevisionPublicationService, RevisionCatalogService, CanonicalReadingService],
})
export class BookRevisionModule {}

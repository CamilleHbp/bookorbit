import { Module } from '@nestjs/common';
import { FileLockModule } from '../../common/file-lock.module';
import { BookRevisionService } from './book-revision.service';
import { EpubManifestService } from './epub-manifest.service';

import { RevisionPublicationService } from './revision-publication.service';

import { RevisionCatalogService } from './revision-catalog.service';

@Module({
  imports: [FileLockModule],
  providers: [BookRevisionService, EpubManifestService, RevisionPublicationService, RevisionCatalogService],
  exports: [BookRevisionService, EpubManifestService, RevisionPublicationService, RevisionCatalogService],
})
export class BookRevisionModule {}

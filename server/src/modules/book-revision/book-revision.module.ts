import { Module } from '@nestjs/common';
import { BookRevisionService } from './book-revision.service';
import { EpubManifestService } from './epub-manifest.service';

import { RevisionPublicationService } from './revision-publication.service';

@Module({
  providers: [BookRevisionService, EpubManifestService, RevisionPublicationService],
  exports: [BookRevisionService, EpubManifestService, RevisionPublicationService],
})
export class BookRevisionModule {}

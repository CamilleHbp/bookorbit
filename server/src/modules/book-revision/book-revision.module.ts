import { Module } from '@nestjs/common';
import { BookRevisionService } from './book-revision.service';
import { EpubManifestService } from './epub-manifest.service';

@Module({ providers: [BookRevisionService, EpubManifestService], exports: [BookRevisionService, EpubManifestService] })
export class BookRevisionModule {}

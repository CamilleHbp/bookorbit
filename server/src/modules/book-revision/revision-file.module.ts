import { Module } from '@nestjs/common';
import { RevisionFileService } from './revision-file.service';
import { EpubManifestService } from './epub-manifest.service';

@Module({ providers: [RevisionFileService, EpubManifestService], exports: [RevisionFileService, EpubManifestService] })
export class RevisionFileModule {}

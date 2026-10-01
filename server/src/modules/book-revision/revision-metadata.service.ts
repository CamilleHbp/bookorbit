import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WriteResult } from '@bookorbit/types';
import { BookRevisionService } from './book-revision.service';
import { RevisionCatalogService } from './revision-catalog.service';
import { RevisionFileService } from './revision-file.service';
import { RevisionPublicationService } from './revision-publication.service';

@Injectable()
export class RevisionMetadataService {
  private active = 0;
  constructor(
    private readonly revisions: BookRevisionService,
    private readonly catalog: RevisionCatalogService,
    private readonly files: RevisionFileService,
    private readonly publications: RevisionPublicationService,
  ) {}

  async rewriteWithinBookOperation(
    bookId: number,
    target: { id: number; libraryId: number; absolutePath: string },
    write: (stagedPath: string) => Promise<WriteResult>,
  ): Promise<WriteResult> {
    if (this.active >= 2) throw new ServiceUnavailableException('Metadata revision capacity is currently in use');
    this.active++;
    let directory: string | undefined;
    try {
      const location = await this.catalog.fileLocation(target.id, target.libraryId);
      if (location.bookId !== bookId || location.absolutePath !== target.absolutePath)
        throw new ConflictException('Book file moved before metadata writing');
      const revision = await this.revisions.observeFile(target.id, {});
      if (revision.bookId !== bookId || revision.absolutePath !== target.absolutePath || !revision.currentRevisionId || !revision.sha256)
        throw new ConflictException('Book identity changed before metadata writing');
      directory = await mkdtemp(join(dirname(target.absolutePath), '.bookorbit-metadata-'));
      const path = join(directory, 'book.epub');
      await this.files.copy(target.absolutePath, path);
      await this.files.require(path, revision.sha256);
      const result = await write(path);
      if (result.status !== 'success') return result;
      const output = await this.files.require(path);
      if (output.sha256 === revision.sha256) return result;
      const publication = await this.publications.prepare(
        target.id,
        target.libraryId,
        revision.currentRevisionId,
        path,
        'file_write',
        undefined,
        output.sha256,
        { bookId, absolutePath: target.absolutePath },
      );
      await this.publications.resumeWithinBookOperation(bookId, publication.publicationId, target.libraryId);
      return result;
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        this.active--;
      }
    }
  }
}

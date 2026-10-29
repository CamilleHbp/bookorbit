import { BadRequestException, Injectable } from '@nestjs/common';
import type { ReadingAnchor } from '@bookorbit/types';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';

@Injectable()
export class AnnotationAnchorService {
  constructor(private readonly revisions: RevisionCatalogService) {}

  async validate(bookId: number, bookFileId: number, anchors: ReadingAnchor[]): Promise<void> {
    const revisions = new Set<string>();
    for (const anchor of anchors) {
      if (anchor.schemaVersion !== 1 || anchor.bookId !== bookId || anchor.bookFileId !== bookFileId || !anchor.nativeLocator) {
        throw new BadRequestException('Annotation anchor does not match its logical book file');
      }
      if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(anchor.revision)) revisions.add(anchor.revision);
      else if (
        !anchor.provisionalSha256 ||
        !/^[a-f0-9]{64}$/.test(anchor.provisionalSha256) ||
        anchor.revision !== `sha256:${anchor.provisionalSha256}`
      ) {
        throw new BadRequestException('Annotation anchor has no valid revision identity');
      }
    }
    await this.revisions.requireRevisions(bookFileId, [...revisions]);
  }
}

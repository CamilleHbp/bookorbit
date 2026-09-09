import { Injectable } from '@nestjs/common';
import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { RevisionCatalogService } from './revision-catalog.service';
import { ListRevisionsDto, ResolveReadingAnchorDto } from './dto/reading-anchor.dto';

@Injectable()
export class RevisionApiService {
  constructor(
    private readonly books: BookService,
    private readonly revisions: RevisionCatalogService,
  ) {}

  async list(libraryId: number, fileId: number, dto: ListRevisionsDto, user: RequestUser) {
    await this.books.verifyFileAccess(fileId, user);
    return this.revisions.list(fileId, libraryId, dto.limit, dto.cursor);
  }

  async manifest(libraryId: number, fileId: number, revisionId: string, user: RequestUser) {
    await this.books.verifyFileAccess(fileId, user);
    return this.revisions.manifest(fileId, libraryId, revisionId);
  }

  async resolve(libraryId: number, fileId: number, dto: ResolveReadingAnchorDto, user: RequestUser) {
    await this.books.verifyFileAccess(fileId, user);
    return this.revisions.resolve(fileId, libraryId, dto.targetRevisionId, dto.anchor);
  }
}

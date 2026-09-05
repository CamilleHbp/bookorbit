import { Injectable } from '@nestjs/common';
import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { RevisionCatalogService } from './revision-catalog.service';
import { ListRevisionsDto, ResolveReadingAnchorDto } from './dto/reading-anchor.dto';

@Injectable()
export class RevisionApiService {
  constructor(
    private readonly libraries: LibraryService,
    private readonly revisions: RevisionCatalogService,
  ) {}

  async list(libraryId: number, fileId: number, dto: ListRevisionsDto, user: RequestUser) {
    await this.libraries.verifyUserAccess(user.id, libraryId, user.isSuperuser);
    return this.revisions.list(fileId, libraryId, dto.limit, dto.cursor);
  }

  async manifest(libraryId: number, fileId: number, revisionId: string, user: RequestUser) {
    await this.libraries.verifyUserAccess(user.id, libraryId, user.isSuperuser);
    return this.revisions.manifest(fileId, libraryId, revisionId);
  }

  async resolve(libraryId: number, fileId: number, dto: ResolveReadingAnchorDto, user: RequestUser) {
    await this.libraries.verifyUserAccess(user.id, libraryId, user.isSuperuser);
    return this.revisions.resolve(fileId, libraryId, dto.targetRevisionId, dto.anchor);
  }
}

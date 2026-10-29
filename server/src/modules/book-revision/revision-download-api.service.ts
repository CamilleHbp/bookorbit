import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { UserService } from '../user/user.service';
import { RevisionDownloadService } from './revision-download.service';

@Injectable()
export class RevisionDownloadApiService {
  constructor(
    private readonly books: BookService,
    private readonly users: UserService,
    private readonly downloads: RevisionDownloadService,
  ) {}

  download(libraryId: number, fileId: number, revisionId: string, user: RequestUser, cancelled: () => boolean) {
    return this.downloads.download(fileId, libraryId, revisionId, async () => {
      if (cancelled()) throw new ServiceUnavailableException('Revision download was cancelled');
      const fresh = await this.users.findByIdWithPermissions(user.id);
      if (
        !fresh?.active ||
        fresh.tokenVersion !== user.tokenVersion ||
        (!fresh.isSuperuser && !fresh.permissions.includes(Permission.LibraryDownload))
      ) {
        throw new ForbiddenException('Revision download permission is no longer available');
      }
      const file = await this.books.verifyFileAccess(fileId, fresh);
      if (file.libraryId !== libraryId) throw new ForbiddenException('File moved to a different library');
    });
  }
}

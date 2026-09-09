import { ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { EpubReadingRevision } from '@bookorbit/types';
import type { RequestUser } from '../../../common/types/request-user';
import { BookService } from '../../book/book.service';
import { BookRevisionService } from '../../book-revision/book-revision.service';
import { RevisionDownloadService } from '../../book-revision/revision-download.service';
import { UserService } from '../../user/user.service';

@Injectable()
export class EpubRevisionService {
  constructor(
    private readonly books: BookService,
    private readonly revisions: BookRevisionService,
    private readonly downloads: RevisionDownloadService,
    private readonly users: UserService,
  ) {}

  async current(bookId: number, fileId: number, user: RequestUser): Promise<EpubReadingRevision> {
    const file = await this.access(bookId, fileId, user);
    const inspected = await this.revisions.observeFile(fileId, {});
    const current = await this.access(bookId, fileId, user);
    if (current.libraryId !== file.libraryId) throw new ForbiddenException('File moved to a different library');
    return {
      bookId,
      bookFileId: fileId,
      libraryId: file.libraryId,
      revision: inspected.currentRevisionId!,
      sha256: inspected.sha256!,
      sizeBytes: inspected.sizeBytes!,
    };
  }

  async snapshot(bookId: number, fileId: number, revisionId: string, user: RequestUser, cancelled: () => boolean) {
    const file = await this.access(bookId, fileId, user);
    return this.downloads.download(fileId, file.libraryId, revisionId, async () => {
      if (cancelled()) throw new ServiceUnavailableException('Reader request was cancelled');
      const fresh = await this.users.findByIdWithPermissions(user.id);
      if (!fresh?.active || fresh.tokenVersion !== user.tokenVersion) throw new ForbiddenException('Reader access is no longer available');
      const current = await this.access(bookId, fileId, fresh);
      if (current.libraryId !== file.libraryId) throw new ForbiddenException('File moved to a different library');
    });
  }

  private async access(bookId: number, fileId: number, user: RequestUser) {
    const file = await this.books.verifyFileAccess(fileId, user);
    if (file.bookId !== bookId || file.format !== 'epub') throw new NotFoundException('EPUB file not found for this book');
    return file;
  }
}

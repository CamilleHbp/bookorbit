import { Injectable } from '@nestjs/common';
import type { DeviceCanonicalReadingState } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { CanonicalReadingService } from '../book-revision/canonical-reading.service';
import { AcknowledgeReadingPositionDto, RecordReadingEventDto } from '../book-revision/dto/reading-event.dto';

@Injectable()
export class KoreaderReadingService {
  constructor(
    private readonly books: BookService,
    private readonly reading: CanonicalReadingService,
  ) {}

  async state(fileId: number, user: RequestUser): Promise<DeviceCanonicalReadingState> {
    const file = await this.books.verifyFileAccess(fileId, user);
    const state = await this.reading.state(user.id, fileId, file.libraryId);
    return { ...state, bookId: file.bookId, bookFileId: fileId, revision: file.currentRevisionId, sha256: file.sha256 };
  }

  async record(fileId: number, dto: RecordReadingEventDto, user: RequestUser) {
    const file = await this.books.verifyFileAccess(fileId, user);
    return this.reading.record(user.id, fileId, file.libraryId, dto.anchor);
  }

  async acknowledge(fileId: number, dto: AcknowledgeReadingPositionDto, user: RequestUser) {
    const file = await this.books.verifyFileAccess(fileId, user);
    return this.reading.acknowledge(user.id, fileId, file.libraryId, dto.deviceId, dto.copyId, dto.acknowledgement);
  }
}

import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type { ReadingEventLibraryChange } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { CanonicalReadingService } from './canonical-reading.service';
import { AcknowledgeReadingPositionDto, RecordReadingEventDto } from './dto/reading-event.dto';

@Injectable()
export class ReadingEventApiService {
  constructor(
    private readonly books: BookService,
    private readonly reading: CanonicalReadingService,
  ) {}

  async state(libraryId: number, fileId: number, user: RequestUser) {
    await this.books.verifyFileAccess(fileId, user);
    return this.reading.state(user.id, fileId, libraryId);
  }

  async record(libraryId: number, fileId: number, dto: RecordReadingEventDto, user: RequestUser) {
    if (dto.expectedUserId !== undefined && dto.expectedUserId !== user.id)
      throw new ForbiddenException('The queued reading event belongs to another account');
    const file = await this.books.verifyFileAccess(fileId, user);
    if (file.libraryId !== libraryId)
      throw new ConflictException({
        errorCode: 'reading_library_changed',
        errorMeta: { libraryId: file.libraryId },
      } satisfies ReadingEventLibraryChange);
    return this.reading.record(user.id, fileId, libraryId, dto.anchor);
  }

  async acknowledge(libraryId: number, fileId: number, dto: AcknowledgeReadingPositionDto, user: RequestUser) {
    await this.books.verifyFileAccess(fileId, user);
    return this.reading.acknowledge(user.id, fileId, libraryId, dto.deviceId, dto.copyId, dto.acknowledgement);
  }
}

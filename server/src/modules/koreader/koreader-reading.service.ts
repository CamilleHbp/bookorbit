import { Injectable, NotFoundException } from '@nestjs/common';
import { KoreaderDeliveryExecutionService } from './koreader-delivery-execution.service';
import type { DeviceCanonicalReadingState, DeviceReadingEventReceipt } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { BookReadService } from '../book/book-read.service';
import { CanonicalReadingService } from '../book-revision/canonical-reading.service';
import { AcknowledgeReadingPositionDto, RecordReadingEventDto } from '../book-revision/dto/reading-event.dto';

@Injectable()
export class KoreaderReadingService {
  constructor(
    private readonly books: BookReadService,
    private readonly reading: CanonicalReadingService,
    private readonly deliveries: KoreaderDeliveryExecutionService,
  ) {}

  async state(fileId: number, user: RequestUser): Promise<DeviceCanonicalReadingState> {
    const file = await this.requireFile(fileId, user);
    const state = await this.reading.state(user.id, fileId, file.libraryId);
    return { ...state, bookId: file.bookId, bookFileId: fileId, revision: file.currentRevisionId, sha256: file.sha256 };
  }

  async record(fileId: number, dto: RecordReadingEventDto, user: RequestUser): Promise<DeviceReadingEventReceipt> {
    const file = await this.requireFile(fileId, user);
    const receipt = await this.reading.record(user.id, fileId, file.libraryId, dto.anchor);
    return { ...receipt, bookId: file.bookId, bookFileId: fileId, revision: file.currentRevisionId, sha256: file.sha256 };
  }

  async acknowledge(fileId: number, dto: AcknowledgeReadingPositionDto, user: RequestUser) {
    const file = await this.requireFile(fileId, user);
    const state = await this.reading.acknowledge(user.id, fileId, file.libraryId, dto.deviceId, dto.copyId, dto.acknowledgement);
    await this.deliveries.acknowledgeRestoration(user.id, fileId, dto.deviceId, dto.copyId, dto.acknowledgement);
    return state;
  }

  private async requireFile(fileId: number, user: RequestUser) {
    const [file] = await this.books.findAccessibleFiles([fileId], user);
    if (!file) throw new NotFoundException('Reading file unavailable');
    return file;
  }
}

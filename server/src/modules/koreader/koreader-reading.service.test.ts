import { ForbiddenException, ValidationPipe, BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { CanonicalReadingService } from '../book-revision/canonical-reading.service';
import { KoreaderReadingService } from './koreader-reading.service';
import { KoreaderDeliveryExecutionService } from './koreader-delivery-execution.service';
import { RecordReadingEventDto, AcknowledgeReadingPositionDto } from '../book-revision/dto/reading-event.dto';

const user = { id: 7, isSuperuser: false } as RequestUser;
const libraries = { verifyFileAccess: vi.fn() };
const reading = { state: vi.fn(), record: vi.fn(), acknowledge: vi.fn() };
const deliveries = { acknowledgeRestoration: vi.fn() };
const uuid = '95f66679-bff3-4f7e-a8c6-1d4cf246700a';
const anchor = {
  schemaVersion: 1 as const,
  bookId: 2,
  bookFileId: 9,
  revision: uuid,
  chapterIndex: 0,
  chapterFraction: 0.2,
  bookFraction: 0.1,
  event: { id: uuid, deviceId: 'reader', deviceSequence: 4, occurredAt: '2026-09-05T13:00:00.000Z', resetGeneration: 2 },
};
const acknowledgement = {
  deviceId: 'reader',
  copyId: uuid,
  acknowledgement: {
    eventId: uuid,
    revision: uuid,
    nativeLocator: { kind: 'cfi' as const, value: 'epubcfi(/6/2)' },
    quality: 'approximate' as const,
  },
};
let service: KoreaderReadingService;
beforeEach(async () => {
  vi.resetAllMocks();
  libraries.verifyFileAccess.mockResolvedValue({ bookId: 2, libraryId: 5, currentRevisionId: uuid, sha256: null });
  const module = await Test.createTestingModule({
    providers: [
      KoreaderReadingService,
      { provide: BookService, useValue: libraries },
      { provide: CanonicalReadingService, useValue: reading },
      { provide: KoreaderDeliveryExecutionService, useValue: deliveries },
    ],
  }).compile();
  service = module.get(KoreaderReadingService);
});

describe('KOReader reading event boundaries', () => {
  it('denies revoked access before any user data is read or changed', async () => {
    libraries.verifyFileAccess.mockRejectedValue(new ForbiddenException());
    await expect(service.state(9, user)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.record(9, { anchor }, user)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.acknowledge(9, acknowledgement, user)).rejects.toBeInstanceOf(ForbiddenException);
    for (const method of Object.values(reading)) expect(method).not.toHaveBeenCalled();
  });

  it('uses the authenticated user and preserves receipt and acknowledgement responses', async () => {
    const state = { resetGeneration: 2, anchor };
    reading.state.mockResolvedValue(state);
    reading.record.mockResolvedValue({ ...state, outcome: 'accepted' });
    reading.acknowledge.mockResolvedValue(state);
    await expect(service.state(9, user)).resolves.toEqual({ ...state, bookId: 2, bookFileId: 9, revision: uuid, sha256: null });
    await expect(service.record(9, { anchor }, user)).resolves.toEqual({ ...state, outcome: 'accepted' });
    await expect(service.acknowledge(9, acknowledgement, user)).resolves.toEqual(state);
    expect(reading.record).toHaveBeenCalledWith(7, 9, 5, anchor);
    expect(reading.acknowledge).toHaveBeenCalledWith(7, 9, 5, 'reader', uuid, acknowledgement.acknowledgement);
    expect(deliveries.acknowledgeRestoration).toHaveBeenCalledWith(7, 9, 'reader', uuid, acknowledgement.acknowledgement);
    expect(libraries.verifyFileAccess).toHaveBeenCalledWith(9, user);
  });

  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  it('does not verify delivery restoration when the canonical acknowledgement is rejected', async () => {
    reading.acknowledge.mockRejectedValue(new ForbiddenException());
    await expect(service.acknowledge(9, acknowledgement, user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(deliveries.acknowledgeRestoration).not.toHaveBeenCalled();
  });
  it('accepts the versioned request bodies through the actual validation pipe', async () => {
    await expect(pipe.transform({ anchor }, { type: 'body', metatype: RecordReadingEventDto })).resolves.toEqual({ anchor });
    await expect(pipe.transform(acknowledgement, { type: 'body', metatype: AcknowledgeReadingPositionDto })).resolves.toEqual(acknowledgement);
  });

  it.each([
    { anchor, userId: 4 },
    { anchor: { ...anchor, event: { ...anchor.event, deviceSequence: Number.MAX_SAFE_INTEGER + 1 } } },
    { anchor: { ...anchor, event: { ...anchor.event, occurredAt: '2026-09-05T13:00:00' } } },
    { anchor: { ...anchor, event: { ...anchor.event, resetGeneration: -1 } } },
    {},
  ])('rejects identity spoofing, invalid clocks and invalid sequences', async (value) => {
    await expect(pipe.transform(value, { type: 'body', metatype: RecordReadingEventDto })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects acknowledgements without a verified native locator or separate copy identity', async () => {
    await expect(
      pipe.transform({ ...acknowledgement, copyId: undefined }, { type: 'body', metatype: AcknowledgeReadingPositionDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform(
        { ...acknowledgement, acknowledgement: { ...acknowledgement.acknowledgement, nativeLocator: null } },
        { type: 'body', metatype: AcknowledgeReadingPositionDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

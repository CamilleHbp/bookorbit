import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookReadService } from '../book/book-read.service';
import { CanonicalReadingService } from '../book-revision/canonical-reading.service';
import { KoreaderAuthGuard } from './koreader-auth.guard';
import { KoreaderReadingController } from './koreader-reading.controller';
import { KoreaderReadingService } from './koreader-reading.service';
import { KoreaderDeliveryExecutionService } from './koreader-delivery-execution.service';

describe('KOReader reading HTTP contract', () => {
  let app: NestFastifyApplication;
  const books = { findAccessibleFiles: vi.fn() };
  const reading = { state: vi.fn(), record: vi.fn(), acknowledge: vi.fn() };
  const uuid = '95f66679-bff3-4f7e-a8c6-1d4cf246700a';
  const anchor = {
    schemaVersion: 1,
    bookId: 2,
    bookFileId: 9,
    revision: `sha256:${'a'.repeat(64)}`,
    provisionalSha256: 'a'.repeat(64),
    chapterIndex: 8,
    chapterTitle: 'Chapter 9',
    chapterFraction: 0.5,
    bookFraction: 0.84,
    nativeLocator: { kind: 'xpointer', value: '/body/DocFragment[9]/body/p[4]' },
    quote: 'The original passage',
    event: { id: uuid, deviceId: 'offline-reader', deviceSequence: 4, occurredAt: '2026-09-05T13:00:00Z', resetGeneration: 2 },
  };
  const state = { resetGeneration: 2, anchor };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [KoreaderReadingController],
      providers: [
        KoreaderReadingService,
        { provide: BookReadService, useValue: books },
        { provide: CanonicalReadingService, useValue: reading },
        { provide: KoreaderDeliveryExecutionService, useValue: { acknowledgeRestoration: vi.fn() } },
      ],
    })
      .overrideGuard(KoreaderAuthGuard)
      .useValue({
        canActivate: (context: { switchToHttp(): { getRequest(): { user: unknown } } }) => {
          context.switchToHttp().getRequest().user = { id: 7 };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    books.findAccessibleFiles.mockResolvedValue([{ bookId: 2, libraryId: 5, currentRevisionId: uuid, sha256: 'b'.repeat(64) }]);
    reading.state.mockResolvedValue(state);
    reading.record.mockResolvedValue({ ...state, outcome: 'duplicate' });
    reading.acknowledge.mockResolvedValue(state);
  });
  const url = '/api/v1/koreader/plugin/files/9/reading-events';

  it('requires the plugin authentication guard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, KoreaderReadingController)).toEqual([KoreaderAuthGuard]);
  });
  it('accepts the plugin event and separate copy acknowledgement without changing either identity', async () => {
    const received = await app.inject({ method: 'GET', url });
    expect(received.statusCode).toBe(200);
    expect(received.json()).toEqual({ ...state, bookId: 2, bookFileId: 9, revision: uuid, sha256: 'b'.repeat(64) });
    const recorded = await app.inject({ method: 'POST', url, payload: { anchor } });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json()).toEqual({ ...state, outcome: 'duplicate', bookId: 2, bookFileId: 9, revision: uuid, sha256: 'b'.repeat(64) });
    const acknowledgement = { eventId: uuid, revision: `sha256:${'b'.repeat(64)}`, nativeLocator: anchor.nativeLocator, quality: 'relocated' };
    const accepted = await app.inject({
      method: 'POST',
      url: `${url}/acknowledgements`,
      payload: { deviceId: 'offline-reader', copyId: uuid, acknowledgement },
    });
    expect(accepted.statusCode).toBe(201);
    expect(reading.acknowledge).toHaveBeenCalledWith(7, 9, 5, 'offline-reader', uuid, acknowledgement);
    expect(reading.record).toHaveBeenCalledTimes(1);
  });
  it('rejects payload and route identity tampering at the boundary', async () => {
    for (const payload of [
      { anchor, userId: 99 },
      { anchor: { ...anchor, extra: true } },
      { anchor: { ...anchor, event: { ...anchor.event, deviceSequence: -1 } } },
    ]) {
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'GET', url: url.replace('/9/', '/invalid/') })).statusCode).toBe(400);
    expect(reading.record).not.toHaveBeenCalled();
  });
  it('checks current file access for every request', async () => {
    books.findAccessibleFiles.mockRejectedValue(new ForbiddenException());
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, payload: { anchor } })).statusCode).toBe(403);
    expect(reading.state).not.toHaveBeenCalled();
    expect(reading.record).not.toHaveBeenCalled();
  });
});

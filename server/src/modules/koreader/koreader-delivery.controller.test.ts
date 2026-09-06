import { ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Permission } from '@bookorbit/types';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { KoreaderAuthGuard } from './koreader-auth.guard';
import { KoreaderDeliveryController, KoreaderPluginDeliveryController } from './koreader-delivery.controller';
import { KoreaderDeliveryService } from './koreader-delivery.service';
import { KoreaderDeliveryExecutionService } from './koreader-delivery-execution.service';

describe('KOReader delivery HTTP contract', () => {
  let app: NestFastifyApplication;
  const id = 'adef91c7-ef94-4dba-bcaa-889a07538ec7';
  const user = { id: 7 };
  const service = { request: vi.fn(), list: vi.fn(), get: vi.fn(), cancel: vi.fn(), retry: vi.fn() };
  const execution = { claim: vi.fn(), progress: vi.fn(), authorizePublication: vi.fn(), download: vi.fn() };
  const lease = { deviceId: 'reader', token: id, fence: 1 };
  const progress = {
    ...lease,
    sequence: 1,
    state: 'downloading',
    localSha256: 'a'.repeat(64),
    localSizeBytes: 100,
    pathname: '/books/story.epub',
    readingUploadsComplete: true,
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [KoreaderDeliveryController, KoreaderPluginDeliveryController],
      providers: [
        { provide: KoreaderDeliveryService, useValue: service },
        { provide: KoreaderDeliveryExecutionService, useValue: execution },
      ],
    })
      .overrideGuard(KoreaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('preHandler', (request, _reply, done) => {
        Object.assign(request, { user });
        done();
      });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    for (const method of Object.values(service))
      method.mockResolvedValue({ id, installationState: 'requested', restorationState: 'verification_pending' });
    service.list.mockResolvedValue({ items: [], nextCursor: null });
    for (const method of Object.values(execution)) method.mockResolvedValue({ id });
  });
  afterAll(async () => {
    await app?.close();
  });
  it('requires sync and download permissions for mutations and authenticates plugin operations', () => {
    expect(Reflect.getMetadata(PERMISSION_KEY, KoreaderDeliveryController)).toBe(Permission.KoreaderSync);
    expect(Reflect.getMetadata(PERMISSION_KEY, KoreaderDeliveryController.prototype.request)).toEqual([
      Permission.LibraryDownload,
      Permission.KoreaderSync,
    ]);
    expect(Reflect.getMetadata(PERMISSION_KEY, KoreaderDeliveryController.prototype.retry)).toEqual([
      Permission.LibraryDownload,
      Permission.KoreaderSync,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, KoreaderPluginDeliveryController)).toEqual([KoreaderAuthGuard]);
  });
  it('returns durable job identities with 202 for requests, cancellation and explicit retry', async () => {
    const payload = { idempotencyKey: id, expectedRevisionId: id };
    const requested = await app.inject({ method: 'POST', url: `/api/v1/koreader/deliveries/copies/${id}`, payload });
    expect(requested.statusCode).toBe(202);
    expect(requested.json()).toEqual({ id, installationState: 'requested', restorationState: 'verification_pending' });
    expect(service.request).toHaveBeenCalledWith(id, payload, user);
    for (const action of ['cancel', 'retry'] as const) {
      const changed = await app.inject({ method: 'POST', url: `/api/v1/koreader/deliveries/${id}/${action}`, payload: { version: 3 } });
      expect(changed.statusCode).toBe(202);
      expect(service[action]).toHaveBeenCalledWith(id, 3, user);
    }
  });
  it('passes bounded, scoped list requests and exact lease DTOs to the services', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/koreader/plugin/deliveries?limit=25&deviceId=reader&activeOnly=true&installedCopyId=${id}`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [], nextCursor: null });
    expect(service.list).toHaveBeenCalledWith({ limit: 25, deviceId: 'reader', activeOnly: 'true', installedCopyId: id }, user);
    for (const [action, payload, method] of [
      ['claim', { deviceId: 'reader', claimId: id }, 'claim'],
      ['progress', progress, 'progress'],
      ['publication', lease, 'authorizePublication'],
    ] as const) {
      expect((await app.inject({ method: 'POST', url: `/api/v1/koreader/plugin/deliveries/${id}/${action}`, payload })).statusCode).toBe(200);
      expect(execution[method]).toHaveBeenCalledWith(id, payload, user);
    }
  });
  it.each([
    { ...progress, userId: 8 },
    { ...progress, fence: 0 },
    { ...progress, readingUploadsComplete: 'true' },
    { ...progress, localSha256: 'partial-md5' },
    { ...progress, state: 'verified' },
    { ...progress, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...progress, pathname: '/books/\nother' },
    { ...progress, failureCode: 'access_revoked' },
  ])('rejects invalid progress, privilege claims and mixed restoration states', async (payload) => {
    expect((await app.inject({ method: 'POST', url: `/api/v1/koreader/plugin/deliveries/${id}/progress`, payload })).statusCode).toBe(400);
    expect(execution.progress).not.toHaveBeenCalled();
  });
  it('rejects unbounded lists and incomplete request identities', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/koreader/deliveries?limit=101' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/koreader/deliveries?userId=99' })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: `/api/v1/koreader/deliveries/copies/${id}`, payload: { expectedRevisionId: id } })).statusCode,
    ).toBe(400);
  });
  it('streams verified bytes with explicit revision and SHA-256 headers', async () => {
    execution.download.mockResolvedValue({ stream: Readable.from(Buffer.from('EPUB')), sizeBytes: 4, sha256: 'b'.repeat(64), revisionId: id });
    const response = await app.inject({ method: 'POST', url: `/api/v1/koreader/plugin/deliveries/${id}/download`, payload: lease });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('EPUB');
    expect(response.headers['x-bookorbit-revision']).toBe(id);
    expect(response.headers['x-bookorbit-sha256']).toBe('b'.repeat(64));
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(execution.download).toHaveBeenCalledWith(id, lease, user, expect.any(Function));
  });
});

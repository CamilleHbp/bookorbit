import { ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KoreaderAuthGuard } from './koreader-auth.guard';
import { KoreaderCopiesController, KoreaderPluginCopiesController } from './koreader-copy.controller';
import { KoreaderCopyService } from './koreader-copy.service';

describe('KOReader copy inventory HTTP contracts', () => {
  let app: NestFastifyApplication;
  const service = {
    report: vi.fn(),
    list: vi.fn(),
    listDevices: vi.fn(),
    updateCopyPolicy: vi.fn(),
    updateDevicePolicy: vi.fn(),
    acknowledgePolicies: vi.fn(),
  };
  const user = { id: 7 };
  const id = 'adef91c7-ef94-4dba-bcaa-889a07538ec7';
  const input = {
    protocolVersion: 1,
    deviceId: 'reader',
    sequence: 1,
    pluginVersion: '1.5.2',
    deliveryCapabilityVersion: 0,
    positionCapabilityVersion: 1,
    copies: [{ copyId: id, bookFileId: 9, pathname: '/books/story.epub', sha256: 'a'.repeat(64), sizeBytes: 100 }],
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [KoreaderCopiesController, KoreaderPluginCopiesController],
      providers: [{ provide: KoreaderCopyService, useValue: service }],
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
    service.report.mockResolvedValue({
      copies: [{ copyId: id, status: 'accepted', id, revisionId: null, policy: 'notify', effectivePolicyVersion: '1:1' }],
    });
    service.list.mockResolvedValue({ items: [], nextCursor: null });
    service.listDevices.mockResolvedValue({ items: [], nextCursor: null });
    service.updateCopyPolicy.mockResolvedValue({ policy: null, version: 2, effectivePolicyVersion: '1:2' });
    service.updateDevicePolicy.mockResolvedValue({ policy: 'notify', version: 2 });
    service.acknowledgePolicies.mockResolvedValue({ accepted: [id] });
  });
  afterAll(async () => {
    await app?.close();
  });
  it('authenticates plugin reports and preserves independent capability and copy fields', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, KoreaderPluginCopiesController)).toEqual([KoreaderAuthGuard]);
    const result = await app.inject({ method: 'POST', url: '/api/v1/koreader/plugin/copies', payload: input });
    expect(result.statusCode).toBe(200);
    expect(result.json().copies[0]).toMatchObject({ copyId: id, id, policy: 'notify', revisionId: null });
    expect(service.report).toHaveBeenCalledWith(input, user);
  });
  it('requires an explicit device for bounded plugin inventory polling', async () => {
    const url = '/api/v1/koreader/plugin/copies';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${url}?deviceId=reader&limit=100` })).statusCode).toBe(200);
    expect(service.list).toHaveBeenCalledExactlyOnceWith({ deviceId: 'reader', limit: 100 }, user);
  });
  it('validates durable policy acknowledgements separately from installed file reports', async () => {
    const url = '/api/v1/koreader/plugin/copies/policies/acknowledgements';
    const payload = { deviceId: 'reader', copies: [{ id, effectivePolicyVersion: '2:3' }] };
    const result = await app.inject({ method: 'POST', url, payload });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ accepted: [id] });
    expect(service.acknowledgePolicies).toHaveBeenCalledExactlyOnceWith(payload, user);
    for (const invalid of [
      { ...payload, userId: 99 },
      { ...payload, copies: [] },
      { ...payload, copies: [null] },
      { ...payload, copies: [payload.copies[0], payload.copies[0]] },
      { ...payload, copies: [{ id, effectivePolicyVersion: '0:3' }] },
      { ...payload, copies: [{ id, effectivePolicyVersion: '2:3', policy: 'automatic' }] },
    ])
      expect((await app.inject({ method: 'POST', url, payload: invalid })).statusCode).toBe(400);
  });
  it.each([
    { ...input, userId: 99 },
    { ...input, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...input, copies: [input.copies[0], input.copies[0]] },
    { ...input, copies: [null] },
    { ...input, copies: [{ ...input.copies[0], pathname: '/books/\nsecret' }] },
    { ...input, copies: [{ ...input.copies[0], sha256: 'partial-md5' }] },
    { ...input, copies: [{ ...input.copies[0], restored: true }] },
    { ...input, copies: [] },
  ])('rejects malformed or privileged report fields', async (payload) => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/koreader/plugin/copies', payload })).statusCode).toBe(400);
    expect(service.report).not.toHaveBeenCalled();
  });
  it('validates query pagination and passes the authenticated user to inventory reads', async () => {
    const result = await app.inject({ method: 'GET', url: '/api/v1/koreader/copies?limit=50&bookFileId=9&deviceId=reader' });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ items: [], nextCursor: null });
    expect(service.list).toHaveBeenCalledWith({ limit: 50, bookFileId: 9, deviceId: 'reader' }, user);
    expect((await app.inject({ method: 'GET', url: '/api/v1/koreader/copies?limit=101' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/koreader/copies?userId=99' })).statusCode).toBe(400);
  });
  it('accepts explicit inheritance and rejects missing policy and stale-shaped payloads', async () => {
    const url = `/api/v1/koreader/copies/${id}/policy`;
    const result = await app.inject({ method: 'PATCH', url, payload: { version: 1, policy: null } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ policy: null, version: 2, effectivePolicyVersion: '1:2' });
    expect(service.updateCopyPolicy).toHaveBeenCalledWith(id, { version: 1, policy: null }, user);
    expect((await app.inject({ method: 'PATCH', url, payload: { version: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url, payload: { version: 1, policy: 'automatic', acknowledged: true } })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/v1/koreader/copies/devices/reader/policy', payload: { version: 1, policy: 'notify' } }))
        .statusCode,
    ).toBe(200);
    expect(service.updateDevicePolicy).toHaveBeenCalledWith('reader', { version: 1, policy: 'notify' }, user);
  });
});

import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Permission } from '@bookorbit/types';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { LIBRARY_ACCESS_KEY } from '../../common/decorators/require-library-access.decorator';
import { FanfictionController } from './fanfiction.controller';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { FanfictionProfileService } from './fanfiction-profile.service';
import { FanfictionJobService } from './fanfiction-job.service';

describe('Fanfiction HTTP contracts', () => {
  let app: NestFastifyApplication;
  const profiles = { create: vi.fn(), update: vi.fn(), list: vi.fn(), get: vi.fn() };
  const jobs = { preview: vi.fn(), get: vi.fn(), list: vi.fn(), cancel: vi.fn() };
  const uuid = '97e5bb69-36e8-43a2-9e3b-0fb924d1ca2f';
  const base = '/api/v1/libraries/5/fanfiction';
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [FanfictionController],
      providers: [
        { provide: FanfictionProfileService, useValue: profiles },
        { provide: FanfictionJobService, useValue: jobs },
        { provide: FanfictionAccessService, useValue: { administer: vi.fn() } },
        { provide: FanficfareRuntimeService, useValue: { health: vi.fn(), sites: vi.fn() } },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('requires library administration at both permission and library role boundaries', () => {
    expect(Reflect.getMetadata(PERMISSION_KEY, FanfictionController)).toBe(Permission.ManageLibraries);
    expect(Reflect.getMetadata(LIBRARY_ACCESS_KEY, FanfictionController)).toBe('owner');
  });
  it('accepts settings profile fields and returns the exact summary response', async () => {
    const summary = { id: uuid, libraryId: 5, name: 'AO3', version: 1, updatedAt: new Date().toISOString() };
    profiles.create.mockResolvedValue(summary);
    const payload = {
      name: 'AO3',
      configuration: '[defaults]\n',
      credentials: { section: 'archiveofourown.org', username: 'reader', password: '********' },
    };
    const response = await app.inject({ method: 'POST', url: `${base}/profiles`, payload });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(summary);
    expect(profiles.create).toHaveBeenCalledWith(5, expect.objectContaining(payload), undefined);
    expect((await app.inject({ method: 'POST', url: `${base}/profiles`, payload: { ...payload, libraryId: 99 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `${base}/profiles/${uuid}`, payload })).statusCode).toBe(400);
  });
  it('accepts durable preview and cancellation requests with 202 responses and rejects oversized pagination', async () => {
    const job = { id: uuid, state: 'queued', libraryId: 5 };
    jobs.preview.mockResolvedValue(job);
    jobs.cancel.mockResolvedValue({ ...job, state: 'cancelled' });
    const payload = { url: 'https://archiveofourown.org/works/123', profileId: uuid, idempotencyKey: uuid };
    const response = await app.inject({ method: 'POST', url: `${base}/previews`, payload });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(job);
    expect((await app.inject({ method: 'POST', url: `${base}/jobs/${uuid}/cancel`, payload: {} })).statusCode).toBe(202);
    expect((await app.inject({ method: 'GET', url: `${base}/jobs?limit=101` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${base}/previews`, payload: { ...payload, url: 'file:///etc/passwd' } })).statusCode).toBe(400);
  });
});

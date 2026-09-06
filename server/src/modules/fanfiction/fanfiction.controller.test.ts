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
import { FanfictionSourceController } from './fanfiction-source.controller';
import { FanfictionSourceService } from './fanfiction-source.service';
import { FanfictionDiscoveryController } from './fanfiction-discovery.controller';
import { FanfictionDiscoveryService } from './fanfiction-discovery.service';
import { FanfictionAdoptionService } from './fanfiction-adoption.service';
import { FanfictionActivityService } from './fanfiction-activity.service';

describe('Fanfiction HTTP contracts', () => {
  let app: NestFastifyApplication;
  const profiles = { create: vi.fn(), update: vi.fn(), list: vi.fn(), get: vi.fn() };
  const jobs = { preview: vi.fn(), get: vi.fn(), list: vi.fn(), cancel: vi.fn(), status: vi.fn(), retry: vi.fn() };
  const sources = { create: vi.fn(), list: vi.fn(), get: vi.fn(), update: vi.fn(), check: vi.fn(), rollback: vi.fn() };
  const discovery = { start: vi.fn(), list: vi.fn() };
  const adoption = { start: vi.fn() };
  const activity = { list: vi.fn() };
  const uuid = '97e5bb69-36e8-43a2-9e3b-0fb924d1ca2f';
  const base = '/api/v1/libraries/5/fanfiction';
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [FanfictionController, FanfictionSourceController, FanfictionDiscoveryController],
      providers: [
        { provide: FanfictionProfileService, useValue: profiles },
        { provide: FanfictionJobService, useValue: jobs },
        { provide: FanfictionSourceService, useValue: sources },
        { provide: FanfictionDiscoveryService, useValue: discovery },
        { provide: FanfictionAdoptionService, useValue: adoption },
        { provide: FanfictionActivityService, useValue: activity },
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
    expect(Reflect.getMetadata(PERMISSION_KEY, FanfictionDiscoveryController)).toBe(Permission.ManageLibraries);
    expect(Reflect.getMetadata(LIBRARY_ACCESS_KEY, FanfictionDiscoveryController)).toBe('owner');
    expect(Reflect.getMetadata(PERMISSION_KEY, FanfictionController)).toBe(Permission.ManageLibraries);
    expect(Reflect.getMetadata(LIBRARY_ACCESS_KEY, FanfictionController)).toBe('owner');
    expect(Reflect.getMetadata(PERMISSION_KEY, FanfictionSourceController)).toBe(Permission.ManageLibraries);
    expect(Reflect.getMetadata(LIBRARY_ACCESS_KEY, FanfictionSourceController)).toBe('owner');
  });
  it('validates discovery and saved selection requests with durable 202 responses', async () => {
    const job = { id: uuid, kind: 'discovery', state: 'queued' };
    discovery.start.mockResolvedValue(job);
    const started = await app.inject({ method: 'POST', url: `${base}/discovery`, payload: { idempotencyKey: uuid } });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual(job);
    expect(discovery.start).toHaveBeenCalledWith(5, uuid, undefined);
    adoption.start.mockResolvedValue({ ...job, kind: 'adopt' });
    const payload = { idempotencyKey: uuid, decision: 'approve', state: 'pending', allMatching: true, profileId: null, intervalMinutes: null };
    expect((await app.inject({ method: 'POST', url: `${base}/discovery/selection`, payload })).statusCode).toBe(202);
    expect(adoption.start).toHaveBeenCalledWith(5, expect.objectContaining(payload), undefined);
    for (const invalid of [
      { ...payload, intervalMinutes: 59 },
      { ...payload, force: true },
      { ...payload, ids: Array.from({ length: 101 }, () => uuid) },
      { ...payload, allMatching: 'true' },
    ])
      expect((await app.inject({ method: 'POST', url: `${base}/discovery/selection`, payload: invalid })).statusCode).toBe(400);
    discovery.list.mockResolvedValue({ items: [], nextCursor: null });
    const page = await app.inject({ method: 'GET', url: `${base}/discovery?limit=50&state=ambiguous` });
    expect(page.json()).toEqual({ items: [], nextCursor: null });
    expect(discovery.list).toHaveBeenCalledWith(5, expect.objectContaining({ limit: 50, state: 'ambiguous' }), undefined);
    expect((await app.inject({ method: 'GET', url: `${base}/discovery?limit=101` })).statusCode).toBe(400);
    jobs.list.mockResolvedValue({ items: [job], nextCursor: null });
    const recovery = await app.inject({ method: 'GET', url: `${base}/jobs?kind=discovery&activeOnly=true&limit=1` });
    expect(recovery.statusCode).toBe(200);
    expect(recovery.json()).toEqual({ items: [job], nextCursor: null });
    expect(jobs.list).toHaveBeenCalledWith(5, expect.objectContaining({ kind: 'discovery', activeOnly: 'true', limit: 1 }), undefined);
    expect((await app.inject({ method: 'GET', url: `${base}/jobs?kind=unknown` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${base}/jobs?activeOnly=yes` })).statusCode).toBe(400);
    const sourceJob = await app.inject({ method: 'GET', url: `${base}/jobs?sourceId=${uuid}&activeOnly=true&limit=1` });
    expect(sourceJob.statusCode).toBe(200);
    expect(sourceJob.json()).toEqual({ items: [job], nextCursor: null });
    expect(jobs.list).toHaveBeenCalledWith(5, expect.objectContaining({ sourceId: uuid, activeOnly: 'true', limit: 1 }), undefined);
    expect((await app.inject({ method: 'GET', url: `${base}/jobs?sourceId=invalid` })).statusCode).toBe(400);
  });
  it('validates separate update and refresh jobs with a durable operation identity', async () => {
    const job = { id: uuid, kind: 'update', state: 'queued', libraryId: 5 };
    sources.check.mockResolvedValue(job);
    const result = await app.inject({ method: 'POST', url: `${base}/sources/${uuid}/check`, payload: { kind: 'update', idempotencyKey: uuid } });
    expect(result.statusCode).toBe(202);
    expect(result.json()).toEqual(job);
    expect(sources.check).toHaveBeenCalledWith(5, uuid, 'update', uuid, undefined);
    for (const payload of [{ kind: 'update' }, { kind: 'overwrite', idempotencyKey: uuid }, { kind: 'refresh', idempotencyKey: uuid, force: true }])
      expect((await app.inject({ method: 'POST', url: `${base}/sources/${uuid}/check`, payload })).statusCode).toBe(400);
  });
  it('returns bounded durable activity with the frontend response contract', async () => {
    const page = {
      items: [
        {
          id: uuid,
          libraryId: 5,
          sourceId: null,
          jobId: uuid,
          kind: 'imported',
          title: 'Story',
          bookId: 8,
          revisionId: null,
          errorCode: null,
          createdAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
    };
    activity.list.mockResolvedValue(page);
    const result = await app.inject({ method: 'GET', url: `${base}/activity?limit=50` });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(page);
    expect(activity.list).toHaveBeenCalledWith(5, expect.objectContaining({ limit: 50 }), undefined);
    expect((await app.inject({ method: 'GET', url: `${base}/activity?limit=101` })).statusCode).toBe(400);
  });
  it('requires explicit revision identities for rollback and validates book source filtering', async () => {
    const job = { id: uuid, state: 'queued', kind: 'rollback' };
    sources.rollback.mockResolvedValue(job);
    const payload = { idempotencyKey: uuid, revisionId: uuid, expectedRevisionId: uuid };
    const result = await app.inject({ method: 'POST', url: `${base}/sources/${uuid}/rollback`, payload });
    expect(result.statusCode).toBe(202);
    expect(result.json()).toEqual(job);
    expect(sources.rollback).toHaveBeenCalledWith(5, uuid, expect.objectContaining(payload), undefined);
    expect((await app.inject({ method: 'POST', url: `${base}/sources/${uuid}/rollback`, payload: { revisionId: uuid } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${base}/sources/${uuid}/rollback`, payload: { ...payload, force: true } })).statusCode).toBe(
      400,
    );
    sources.list.mockResolvedValue({ items: [], nextCursor: null });
    expect((await app.inject({ method: 'GET', url: `${base}/sources?bookId=12&limit=50` })).statusCode).toBe(200);
    expect(sources.list).toHaveBeenCalledWith(5, expect.objectContaining({ bookId: 12, limit: 50 }), undefined);
    expect((await app.inject({ method: 'GET', url: `${base}/sources?bookId=0` })).statusCode).toBe(400);
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
  it('accepts cookie edits and returns masked cookie metadata through the profile contract', async () => {
    const cookie = { name: 'session', domain: 'archiveofourown.org', path: '/', secure: true, value: '********' };
    const view = {
      id: uuid,
      libraryId: 5,
      name: 'AO3',
      version: 2,
      updatedAt: new Date().toISOString(),
      configuration: '',
      cookieCount: 1,
      cookies: [cookie],
    };
    profiles.get.mockResolvedValue(view);
    expect((await app.inject({ method: 'GET', url: `${base}/profiles/${uuid}` })).json()).toEqual(view);
    const payload = { name: 'AO3', version: 2, cookies: [cookie] };
    profiles.update.mockResolvedValue({ ...view, version: 3 });
    expect((await app.inject({ method: 'PATCH', url: `${base}/profiles/${uuid}`, payload })).statusCode).toBe(200);
    expect(profiles.update).toHaveBeenCalledWith(5, uuid, expect.objectContaining(payload), undefined);
    for (const invalid of [
      { ...cookie, key: 'client-only' },
      { ...cookie, value: 'bad\nvalue' },
      { ...cookie, expires: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect((await app.inject({ method: 'PATCH', url: `${base}/profiles/${uuid}`, payload: { ...payload, cookies: [invalid] } })).statusCode).toBe(
        400,
      );
  });
  it('accepts durable preview and cancellation requests with 202 responses and rejects oversized pagination', async () => {
    const job = { id: uuid, state: 'queued', libraryId: 5 };
    jobs.preview.mockResolvedValue(job);
    jobs.cancel.mockResolvedValue({ ...job, state: 'cancelled' });
    jobs.retry.mockResolvedValue(job);
    const payload = { url: 'https://archiveofourown.org/works/123', profileId: uuid, idempotencyKey: uuid };
    const response = await app.inject({ method: 'POST', url: `${base}/previews`, payload });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(job);
    expect((await app.inject({ method: 'POST', url: `${base}/jobs/${uuid}/cancel`, payload: {} })).statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: `${base}/jobs/${uuid}/retry`, payload: {} })).statusCode).toBe(202);
    expect(jobs.retry).toHaveBeenCalledWith(5, uuid, undefined);
    expect((await app.inject({ method: 'GET', url: `${base}/jobs?limit=101` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${base}/previews`, payload: { ...payload, url: 'file:///etc/passwd' } })).statusCode).toBe(400);
    jobs.status.mockResolvedValue({ items: [job] });
    const status = await app.inject({ method: 'POST', url: `${base}/jobs/status`, payload: { ids: [uuid] } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ items: [job] });
    expect(jobs.status).toHaveBeenCalledWith(5, [uuid], undefined);
    expect((await app.inject({ method: 'POST', url: `${base}/jobs/status`, payload: { ids: Array(101).fill(uuid) } })).statusCode).toBe(400);
  });

  it('validates import, manual scheduling, bounded source queries, and optimistic source changes', async () => {
    const job = { id: uuid, state: 'queued', kind: 'import', libraryId: 5 };
    sources.create.mockResolvedValue(job);
    const payload = { url: 'https://archiveofourown.org/works/123', idempotencyKey: uuid, folderId: 8, intervalMinutes: null };
    const response = await app.inject({ method: 'POST', url: `${base}/sources`, payload });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(job);
    expect(sources.create).toHaveBeenCalledWith(5, expect.objectContaining(payload), undefined);
    expect((await app.inject({ method: 'POST', url: `${base}/sources`, payload: { ...payload, intervalMinutes: 59 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${base}/sources`, payload: { ...payload, absolutePath: '/tmp/story.epub' } })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ method: 'GET', url: `${base}/sources?limit=101` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `${base}/sources/${uuid}`, payload: { state: 'paused' } })).statusCode).toBe(400);
    sources.update.mockResolvedValue({ id: uuid, state: 'paused', version: 2 });
    expect((await app.inject({ method: 'PATCH', url: `${base}/sources/${uuid}`, payload: { state: 'paused', version: 1 } })).statusCode).toBe(200);
  });
});

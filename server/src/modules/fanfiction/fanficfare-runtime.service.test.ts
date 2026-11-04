import { tmpdir } from 'node:os';
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fanficfareConfig, storageConfig } from '../../config/config';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';

const output = vi.hoisted(() => ({ response: {} as unknown, request: {} as Record<string, unknown> }));
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  return {
    spawn: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      const chunks: Buffer[] = [];
      child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stdin.once('finish', () => {
        output.request = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        child.stdout.write(JSON.stringify(output.response));
        child.emit('close', 0);
      });
      return child;
    }),
  };
});

const cookie = { name: 'session', value: 'private-renewal', domain: 'example.org', path: '/', secure: true, hostOnly: true };
describe('private FanFicFare runtime session output', () => {
  afterEach(() => vi.restoreAllMocks());
  let service: FanficfareRuntimeService;
  let runtimeConfig: { python: string; maxWorkers: number; timeoutMs: number; flaresolverrUrl?: string };
  beforeEach(async () => {
    runtimeConfig = { python: 'controlled-python', maxWorkers: 2, timeoutMs: 1000 };
    const module = await Test.createTestingModule({
      providers: [
        FanficfareRuntimeService,
        { provide: fanficfareConfig.KEY, useValue: runtimeConfig },
        { provide: storageConfig.KEY, useValue: { appDataPath: tmpdir() } },
      ],
    }).compile();
    service = module.get(FanficfareRuntimeService);
    output.response = { ok: true, result: { title: 'Public preview' }, cookies: [cookie] };
  });
  it('accepts a large personal rulebook while keeping input bounded', async () => {
    const rules = Array.from({ length: 6000 }, (_, index) => ({
      source: null,
      field: 'tags',
      value: `Source label ${index}`,
      targets: [{ field: 'tags', name: 'Approved canonical tag' }],
    }));
    await service.execute({ operation: 'preview', tagMatching: { version: 1, rules } }, '/unused');
    expect(output.request.tagMatching).toMatchObject({ version: 1, rules: expect.any(Array) });
    await expect(service.execute({ operation: 'validate', configuration: 'x'.repeat(8 * 1024 * 1024) }, '/unused')).rejects.toThrow('input limit');
  });
  it('passes the operator solver endpoint and allows browser download deadlines while retaining the direct request timeout', async () => {
    runtimeConfig.flaresolverrUrl = 'http://solver:8191/v1';
    await service.execute({ operation: 'download', url: 'https://www.scribblehub.com/series/123/story/' }, '/unused');
    expect(output.request).toMatchObject({ flaresolverrUrl: 'http://solver:8191/v1', timeoutSeconds: 1, browserTimeoutSeconds: 7200 });
    await service.execute({ operation: 'download', url: 'https://example.org/story' }, '/unused');
    expect(output.request).toMatchObject({ timeoutSeconds: 1, browserTimeoutSeconds: 7200 });
    await service.execute({ operation: 'merge' }, '/unused');
    expect(output.request.timeoutSeconds).toBe(1);
  });
  it.each([
    ['identity_mismatch', 'source_identity_mismatch'],
    ['chapter_reduction', 'source_chapter_reduction'],
  ])('retains the actionable reason for %s without publishing', async (reason, errorCode) => {
    output.response = { ok: true, result: { reviewRequired: reason } };
    const consume = vi.fn();
    await expect(
      service.update('update', 'https://example.org/story', { configuration: '', cookies: [] }, async () => {}, consume),
    ).rejects.toMatchObject({ response: { errorCode } });
    expect(consume).not.toHaveBeenCalled();
  });
  it('awaits private persistence and returns only public result fields', async () => {
    let persisted = false;
    const saveCookies = vi.fn(async () => {
      await Promise.resolve();
      persisted = true;
    });
    const result = await service.execute({ operation: 'preview' }, '/unused', undefined, saveCookies);
    expect(persisted).toBe(true);
    expect(saveCookies).toHaveBeenCalledWith([cookie]);
    expect(result).toEqual({ title: 'Public preview' });
    expect(JSON.stringify(result)).not.toContain('private-renewal');
  });
  it('keeps website catalog and credential edits available when every download worker is occupied', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const downloads = [1, 2].map(() => service.execute({ operation: 'download' }, '/unused', undefined, () => gate));
    try {
      await expect(service.execute({ operation: 'download' }, '/unused')).rejects.toThrow('busy');
      await expect(service.execute({ operation: 'sites' }, '/unused')).resolves.toEqual({ title: 'Public preview' });
      await expect(service.execute({ operation: 'merge' }, '/unused')).resolves.toEqual({ title: 'Public preview' });
      await expect(service.execute({ operation: 'download' }, '/unused')).rejects.toThrow('busy');
    } finally {
      release();
      await Promise.all(downloads);
    }
  });

  it('queues local requests and continues after a failed request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = service.execute({ operation: 'merge' }, '/unused', undefined, async () => {
      await gate;
      throw new Error('save failed');
    });
    const failure = expect(first).rejects.toThrow('save failed');
    let completed = false;
    const second = service.execute({ operation: 'sites' }, '/unused').then(() => {
      completed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    release();
    await failure;
    await second;
    expect(completed).toBe(true);
  });
  it('blocks publication when cookie persistence fails', async () => {
    const saveCookies = vi.fn(() => Promise.reject(new Error('Encrypted storage unavailable')));
    await expect(service.execute({ operation: 'preview' }, '/unused', undefined, saveCookies)).rejects.toThrow('Encrypted storage unavailable');
  });
  it('does not pass malformed cookie output to storage', async () => {
    output.response = { ok: true, result: {}, cookies: [{ ...cookie, value: 'injected\r\nheader' }] };
    const saveCookies = vi.fn();
    await expect(service.execute({ operation: 'preview' }, '/unused', undefined, saveCookies)).rejects.toThrow('Invalid runtime cookie');
    expect(saveCookies).not.toHaveBeenCalled();
  });
  it('does not retain a jar from failed or cancelled operations', async () => {
    const saveCookies = vi.fn();
    output.response = { ok: false, code: 'authentication_required', cookies: [cookie] };
    await expect(service.execute({ operation: 'preview' }, '/unused', undefined, saveCookies)).rejects.toThrow('could not complete');
    await expect(service.execute({ operation: 'preview' }, '/unused', AbortSignal.abort(), saveCookies)).rejects.toThrow('cancelled');
    expect(saveCookies).not.toHaveBeenCalled();
  });
  it('preserves the actual failure code and logs bounded diagnostics without private output', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    output.response = {
      ok: false,
      code: 'download_limit',
      httpStatus: 429,
      errorClass: 'DownloadLimitError',
      errorLocation: 'safe_transport.py:240:read_body\n',
      message: 'private-secret',
      cookies: [cookie],
    };
    await expect(service.execute({ operation: 'download' }, '/unused')).rejects.toMatchObject({
      response: { errorCode: 'download_limit' },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('errorClass=DownloadLimitError errorCode=download_limit location=safe_transport.py:240:read_body httpStatus=429'),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-secret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-renewal');
  });
});

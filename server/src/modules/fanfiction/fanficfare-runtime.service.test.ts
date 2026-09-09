import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fanficfareConfig, storageConfig } from '../../config/config';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';

const output = vi.hoisted(() => ({ response: {} as unknown }));
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
      child.stdin.once('finish', () => {
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
  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        FanficfareRuntimeService,
        { provide: fanficfareConfig.KEY, useValue: { python: 'controlled-python', maxWorkers: 2, timeoutMs: 1000 } },
        { provide: storageConfig.KEY, useValue: { appDataPath: '/unused-test-workspace' } },
      ],
    }).compile();
    service = module.get(FanficfareRuntimeService);
    output.response = { ok: true, result: { title: 'Public preview' }, cookies: [cookie] };
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
      errorClass: 'DownloadLimitError',
      errorLocation: 'safe_transport.py:240:read_body\n',
      message: 'private-secret',
      cookies: [cookie],
    };
    await expect(service.execute({ operation: 'download' }, '/unused')).rejects.toMatchObject({
      response: { errorCode: 'download_limit' },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('errorClass=DownloadLimitError errorCode=download_limit location=safe_transport.py:240:read_body'),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-secret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-renewal');
  });
});

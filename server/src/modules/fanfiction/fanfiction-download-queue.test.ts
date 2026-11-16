import { describe, expect, it } from 'vitest';
import { downloadWaitReason } from './fanfiction-download-queue';

const now = new Date('2026-11-16T10:00:00Z');
const job = { state: 'queued' as const, site: 'fiction.live', runAfter: now, leaseExpiresAt: null, cancellationRequested: false };
describe('reader-facing download wait reasons', () => {
  it('distinguishes website pacing, capacity, future retries and ready work', () => {
    expect(downloadWaitReason(job, ['fiction.live'], now)).toBe('website_busy');
    expect(downloadWaitReason(job, ['example.org', 'other.example'], now)).toBe('downloads_busy');
    expect(downloadWaitReason(job, [], now)).toBe('ready');
    expect(downloadWaitReason({ ...job, runAfter: new Date(now.getTime() + 60000) }, ['fiction.live'], now)).toBe('scheduled_retry');
  });
  it('does not call a lost or cancelled download active work', () => {
    expect(downloadWaitReason({ ...job, state: 'running', leaseExpiresAt: new Date(now.getTime() - 1) }, [], now)).toBe('recovery');
    expect(downloadWaitReason({ ...job, cancellationRequested: true }, [], now)).toBe('cancelling');
    expect(downloadWaitReason({ ...job, state: 'running', leaseExpiresAt: new Date(now.getTime() + 60000) }, [], now)).toBeUndefined();
    expect(downloadWaitReason({ ...job, state: 'failed' }, [], now)).toBeUndefined();
  });
});

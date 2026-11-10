import { describe, expect, it } from 'vitest';
import { retryDelaySeconds, shouldRetryJob } from './fanfiction-download-retry';

describe('background chapter retries', () => {
  it.each(['import', 'update', 'refresh'] as const)('keeps %s recoverable after repeated interruptions', (kind) => {
    expect(shouldRetryJob(kind, 32, 'source_failed', false)).toBe(true);
    expect(shouldRetryJob(kind, 32, 'runtime_failed', true)).toBe(true);
    expect(shouldRetryJob(kind, 2, 'source_not_found', false)).toBe(false);
    expect(shouldRetryJob(kind, 2, 'source_policy_blocked', false)).toBe(false);
    expect(shouldRetryJob(kind, 2, 'invalid_epub', false)).toBe(false);
    expect(retryDelaySeconds(kind, 1)).toBeGreaterThanOrEqual(30);
    expect(retryDelaySeconds(kind, 1)).toBeLessThan(45);
    expect(retryDelaySeconds(kind, 2)).toBeGreaterThanOrEqual(60);
    expect(retryDelaySeconds(kind, 100_000)).toBe(3600);
  });
});

import { describe, expect, it } from 'vitest';
import type { ReadingEventIdentity } from '@bookorbit/types';
import { isNewerReadingEvent } from './reading-event';

const event: ReadingEventIdentity = { id: 'a', deviceId: 'reader', deviceSequence: 10, resetGeneration: 1, occurredAt: '2026-01-01T12:00:00Z' };

describe('reading event ordering', () => {
  it('ignores replay and late delivery from another device', () => {
    expect(isNewerReadingEvent(event, event)).toBe(false);
    expect(isNewerReadingEvent({ ...event, id: 'b', deviceId: 'other', occurredAt: '2026-01-01T11:00:00Z' }, event)).toBe(false);
  });
  it('orders one device by sequence despite clock corrections', () => {
    expect(isNewerReadingEvent({ ...event, id: 'b', deviceSequence: 11, occurredAt: '2026-01-01T11:00:00Z' }, event)).toBe(true);
  });
  it('keeps an earlier reset generation from replacing post-reset reading', () => {
    expect(isNewerReadingEvent({ ...event, id: 'b', resetGeneration: 0, deviceSequence: 99 }, event)).toBe(false);
  });
  it('breaks cross-device ties independently of delivery order', () => {
    const other = { ...event, id: 'b', deviceId: 'other' };
    expect(isNewerReadingEvent(other, event)).toBe(true);
    expect(isNewerReadingEvent(event, other)).toBe(false);
  });
});

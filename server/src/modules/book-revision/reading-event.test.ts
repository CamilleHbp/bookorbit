import { describe, expect, it } from 'vitest';
import type { ReadingAnchor, ReadingEventIdentity } from '@bookorbit/types';
import { isNewerReadingEvent, isSameReadingEvent } from './reading-event';

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

describe('canonical event retry identity', () => {
  const anchor: ReadingAnchor = {
    schemaVersion: 1,
    bookId: 2,
    bookFileId: 9,
    revision: 'sha256:' + 'a'.repeat(64),
    chapterIndex: 8,
    chapterFraction: 0.47058823529411764,
    bookFraction: 0.7,
    event,
    quote: 'Original passage',
  };
  it('accepts JSON decoder roundoff without replacing the stored event', () => {
    const before = structuredClone(anchor);
    expect(isSameReadingEvent(anchor, { ...anchor, chapterFraction: 0.4705882352941176 })).toBe(true);
    expect(anchor).toEqual(before);
  });
  it('rejects changed fractions, locators, quotes and event identities', () => {
    for (const changes of [
      { chapterFraction: anchor.chapterFraction + 1e-12 },
      { bookFraction: 0.8 },
      { quote: 'Different passage' },
      { revision: 'sha256:' + 'b'.repeat(64) },
      { nativeLocator: { kind: 'xpointer' as const, value: '/body/p[2]' } },
      { event: { ...event, deviceSequence: event.deviceSequence + 1 } },
    ]) {
      expect(isSameReadingEvent(anchor, { ...anchor, ...changes })).toBe(false);
    }
  });
});

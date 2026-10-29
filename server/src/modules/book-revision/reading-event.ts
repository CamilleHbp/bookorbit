import { isDeepStrictEqual } from 'node:util';
import type { ReadingAnchor, ReadingEventIdentity } from '@bookorbit/types';

export function isNewerReadingEvent(incoming: ReadingEventIdentity, current: ReadingEventIdentity): boolean {
  if (incoming.id === current.id) return false;
  if (incoming.resetGeneration !== current.resetGeneration) return incoming.resetGeneration > current.resetGeneration;
  if (incoming.deviceId === current.deviceId) return incoming.deviceSequence > current.deviceSequence;
  const incomingTime = Date.parse(incoming.occurredAt);
  const currentTime = Date.parse(current.occurredAt);
  if (!Number.isFinite(incomingTime) || !Number.isFinite(currentTime)) return false;
  if (incomingTime !== currentTime) return incomingTime > currentTime;
  return incoming.id > current.id;
}

export function isSameReadingEvent(stored: ReadingAnchor, incoming: ReadingAnchor): boolean {
  const comparable = { ...incoming };
  for (const key of ['chapterFraction', 'bookFraction'] as const) {
    const expected = stored[key],
      actual = incoming[key];
    // KOReader's JSON decoder can round a persisted double by a few ULPs.
    if (
      Number.isFinite(expected) &&
      Number.isFinite(actual) &&
      Math.abs(expected - actual) <= 4 * Number.EPSILON * Math.max(Math.abs(expected), Math.abs(actual))
    ) {
      comparable[key] = expected;
    }
  }
  return isDeepStrictEqual(stored, comparable);
}

import type { ReadingEventIdentity } from '@bookorbit/types';

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

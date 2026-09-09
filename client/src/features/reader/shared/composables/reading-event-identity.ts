import type { ReadingEventIdentity } from '@bookorbit/types'

let fallbackDevice: string | undefined
let fallbackSequence = 0
function storedDeviceIdentity() {
  let id = localStorage.getItem('bookorbit-reading-device')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('bookorbit-reading-device', id)
  }
  return id
}
export async function readingDeviceIdentity() {
  if (navigator.locks) {
    try {
      return await navigator.locks.request('bookorbit-reading-event', storedDeviceIdentity)
    } catch {
      /* Storage can be unavailable in private browsing. */
    }
  }
  fallbackDevice ??= crypto.randomUUID()
  return fallbackDevice
}
export async function readingEventIdentity(resetGeneration: number, occurredAt: string): Promise<ReadingEventIdentity> {
  const create = () => {
    const deviceId = storedDeviceIdentity()
    const stored = Number(localStorage.getItem('bookorbit-reading-sequence') ?? 0)
    const deviceSequence = Number.isSafeInteger(stored) && stored >= 0 ? stored + 1 : 1
    localStorage.setItem('bookorbit-reading-sequence', String(deviceSequence))
    return { id: crypto.randomUUID(), deviceId, deviceSequence, occurredAt, resetGeneration }
  }
  if (navigator.locks) {
    try {
      return await navigator.locks.request('bookorbit-reading-event', create)
    } catch {
      /* Restricted browser storage uses a unique session identity. */
    }
  }
  fallbackDevice ??= crypto.randomUUID()
  return { id: crypto.randomUUID(), deviceId: fallbackDevice, deviceSequence: ++fallbackSequence, occurredAt, resetGeneration }
}

export function readingCopyIdentity() {
  const key = 'bookorbit-reading-copy'
  try {
    let id = sessionStorage.getItem(key)
    if (!id) {
      id = crypto.randomUUID()
      sessionStorage.setItem(key, id)
    }
    return id
  } catch {
    return crypto.randomUUID()
  }
}

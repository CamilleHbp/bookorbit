import { api } from '@/lib/api'
import type { ReadingAnchor, ReadingEventLibraryChange, ReadingEventReceipt } from '@bookorbit/types'
import { readingEventOutbox, type PendingReadingEvent } from './reading-event-outbox'

async function send(
  owner: number,
  libraryId: number,
  fileId: number,
  anchor: ReadingAnchor,
  signal: AbortSignal,
  saveRoute?: (libraryId: number) => Promise<boolean>,
) {
  const body = JSON.stringify({ anchor, expectedUserId: owner })
  const request = (library: number) =>
    api(`/api/v1/libraries/${library}/files/${fileId}/reading-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal,
    })
  const response = await request(libraryId)
  if (response.status !== 409) return response
  const change = (await response
    .clone()
    .json()
    .catch(() => null)) as ReadingEventLibraryChange | null
  const destination = change?.errorMeta?.libraryId
  if (
    change?.errorCode !== 'reading_library_changed' ||
    typeof destination !== 'number' ||
    !Number.isSafeInteger(destination) ||
    destination < 1 ||
    destination === libraryId
  )
    return response
  if (saveRoute && !(await saveRoute(destination))) return response
  return request(destination)
}

export function sendStoredReadingEvent(event: PendingReadingEvent, signal: AbortSignal) {
  return send(event.userId, event.libraryId, event.fileId, event.request.anchor, signal, async (libraryId) => {
    const eventId = event.request.anchor.event!.id
    if (await readingEventOutbox.relocate(event.userId, eventId, event.libraryId, libraryId)) return true
    return !(await readingEventOutbox.contains(event.userId, eventId))
  })
}

export function sendUnstoredReadingEvent(owner: number, libraryId: number, fileId: number, anchor: ReadingAnchor, signal: AbortSignal) {
  return send(owner, libraryId, fileId, anchor, signal)
}

export async function readReadingEventReceipt(response: Response): Promise<ReadingEventReceipt> {
  const receipt = (await response.json()) as ReadingEventReceipt | null
  if (
    !receipt ||
    !['accepted', 'duplicate', 'superseded', 'reset_required'].includes(receipt.outcome) ||
    !Number.isSafeInteger(receipt.resetGeneration) ||
    receipt.resetGeneration < 0
  )
    throw new Error('Reading synchronization returned an invalid receipt')
  return receipt
}

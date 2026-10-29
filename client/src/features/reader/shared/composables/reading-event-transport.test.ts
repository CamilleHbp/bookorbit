import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadingAnchor } from '@bookorbit/types'
import { api } from '@/lib/api'
import { readingEventOutbox } from './reading-event-outbox'
import { sendStoredReadingEvent } from './reading-event-transport'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const mockApi = vi.mocked(api)
const moved = (libraryId: number) => new Response(JSON.stringify({ errorCode: 'reading_library_changed', errorMeta: { libraryId } }), { status: 409 })

describe('queued reading after a library move', () => {
  const anchor: ReadingAnchor = {
    schemaVersion: 1,
    bookId: 2,
    bookFileId: 9,
    revision: '95f66679-bff3-4f7e-a8c6-1d4cf246700a',
    chapterIndex: 0,
    chapterFraction: 0.2,
    bookFraction: 0.1,
    event: {
      id: '95f66679-bff3-4f7e-a8c6-1d4cf246700b',
      deviceId: 'reader',
      deviceSequence: 1,
      occurredAt: '2026-09-05T13:00:00.000Z',
      resetGeneration: 2,
    },
  }
  beforeEach(() => vi.clearAllMocks())
  afterEach(async () => {
    await readingEventOutbox.close()
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('bookorbit-reading-events')
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  })
  it('saves the verified destination before retrying without changing the original reading event', async () => {
    const event = await readingEventOutbox.put(7, 5, 9, anchor)
    mockApi.mockResolvedValueOnce(moved(6))
    mockApi.mockImplementationOnce(async () => {
      expect((await readingEventOutbox.pending(7, 9))[0]?.libraryId).toBe(6)
      return new Response('{}', { status: 200 })
    })
    expect((await sendStoredReadingEvent(event, new AbortController().signal)).status).toBe(200)
    expect(mockApi.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/libraries/5/files/9/reading-events',
      '/api/v1/libraries/6/files/9/reading-events',
    ])
    expect(mockApi.mock.calls[0]![1]!.body).toBe(mockApi.mock.calls[1]![1]!.body)
    expect((await readingEventOutbox.pending(7, 9))[0]?.request).toEqual({ anchor, expectedUserId: 7 })
  })
  it.each([
    null,
    {},
    { errorCode: 'another_conflict', errorMeta: { libraryId: 6 } },
    { errorCode: 'reading_library_changed' },
    { errorCode: 'reading_library_changed', errorMeta: { libraryId: '6' } },
    { errorCode: 'reading_library_changed', errorMeta: { libraryId: 0 } },
    { errorCode: 'reading_library_changed', errorMeta: { libraryId: 5 } },
  ])('does not reroute an unverified conflict response: %j', async (payload) => {
    const event = await readingEventOutbox.put(7, 5, 9, anchor)
    mockApi.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 409 }))
    expect((await sendStoredReadingEvent(event, new AbortController().signal)).status).toBe(409)
    expect(mockApi).toHaveBeenCalledTimes(1)
    expect((await readingEventOutbox.pending(7, 9))[0]?.libraryId).toBe(5)
  })
  it('retains the event if access is revoked during the retry', async () => {
    const event = await readingEventOutbox.put(7, 5, 9, anchor)
    mockApi.mockResolvedValueOnce(moved(6)).mockResolvedValueOnce(new Response('{}', { status: 403 }))
    expect((await sendStoredReadingEvent(event, new AbortController().signal)).status).toBe(403)
    expect((await readingEventOutbox.pending(7, 9))[0]).toMatchObject({ libraryId: 6, request: { anchor } })
  })

  it('finishes an idempotent retry when another worker already acknowledged the queued event', async () => {
    const event = await readingEventOutbox.put(7, 5, 9, anchor)
    mockApi.mockImplementationOnce(async () => {
      await readingEventOutbox.remove(7, anchor.event!.id)
      return moved(6)
    })
    mockApi.mockResolvedValueOnce(new Response('{}', { status: 200 }))
    expect((await sendStoredReadingEvent(event, new AbortController().signal)).status).toBe(200)
    expect(mockApi).toHaveBeenCalledTimes(2)
    expect(await readingEventOutbox.pending(7, 9)).toEqual([])
  })
  it('bounds relocation retries and refuses a stale routing overwrite', async () => {
    const event = await readingEventOutbox.put(7, 5, 9, anchor)
    mockApi.mockResolvedValueOnce(moved(6)).mockResolvedValueOnce(moved(8))
    expect((await sendStoredReadingEvent(event, new AbortController().signal)).status).toBe(409)
    expect(mockApi).toHaveBeenCalledTimes(2)
    expect(await readingEventOutbox.relocate(7, anchor.event!.id, 5, 8)).toBe(false)
    expect(await readingEventOutbox.relocate(8, anchor.event!.id, 6, 8)).toBe(false)
    expect((await readingEventOutbox.pending(7, 9))[0]?.libraryId).toBe(6)
  })
})

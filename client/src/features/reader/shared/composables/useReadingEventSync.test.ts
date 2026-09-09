import 'fake-indexeddb/auto'
import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadingAnchor } from '@bookorbit/types'
import { api } from '@/lib/api'
import { readingEventOutbox } from './reading-event-outbox'
import { useReadingEventSync } from './useReadingEventSync'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const mockApi = vi.mocked(api)
const response = (outcome = 'accepted', resetGeneration = 2) =>
  new Response(JSON.stringify({ outcome, resetGeneration, anchor: null }), { status: 200 })

describe('reading event synchronization recovery', () => {
  let scope: ReturnType<typeof effectScope>
  const owner = ref<number | null>(7)
  const receive = vi.fn<() => void>()
  const reading = (): ReadingAnchor => ({
    schemaVersion: 1,
    bookId: 2,
    bookFileId: 9,
    revision: '95f66679-bff3-4f7e-a8c6-1d4cf246700a',
    chapterIndex: 0,
    chapterFraction: 0.2,
    bookFraction: 0.1,
    event: { id: crypto.randomUUID(), deviceId: 'reader', deviceSequence: 1, occurredAt: '2026-09-05T13:00:00.000Z', resetGeneration: 2 },
  })
  beforeEach(() => {
    vi.clearAllMocks()
    owner.value = 7
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    scope = effectScope()
  })
  afterEach(async () => {
    scope.stop()
    await readingEventOutbox.close()
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('bookorbit-reading-events')
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
    vi.restoreAllMocks()
  })
  it('sends the latest locally captured position first even after clock rollback', async () => {
    const first = reading()
    await readingEventOutbox.put(7, 5, 9, first)
    vi.spyOn(Date, 'now').mockReturnValue(1)
    const latest = { ...reading(), event: { ...reading().event!, deviceSequence: 2 } }
    await readingEventOutbox.put(7, 5, 9, latest)
    mockApi.mockImplementation(() => Promise.resolve(response()))
    const sync = scope.run(() => useReadingEventSync(9, owner, receive))!
    await sync.flush()
    const requests = mockApi.mock.calls.map(([, init]) => JSON.parse(init!.body as string))
    expect(requests).toEqual([
      { anchor: latest, expectedUserId: 7 },
      { anchor: first, expectedUserId: 7 },
    ])
    expect(await readingEventOutbox.pending(7, 9)).toEqual([])
    expect(receive).toHaveBeenCalledTimes(2)
  })
  it('retains the exact event after an uncertain response and removes it only after a receipt', async () => {
    const original = reading()
    const sync = scope.run(() => useReadingEventSync(9, owner, receive))!
    await sync.persist(7, 5, original)
    mockApi.mockRejectedValueOnce(new Error('Disconnected'))
    await sync.flush()
    expect(sync.error.value).toBe('Disconnected')
    expect(await readingEventOutbox.pending(7, 9)).toHaveLength(1)
    mockApi.mockResolvedValueOnce(response('duplicate'))
    await sync.retry()
    expect(mockApi.mock.calls[0]![1]!.body).toBe(mockApi.mock.calls[1]![1]!.body)
    expect(await readingEventOutbox.pending(7, 9)).toEqual([])
    expect(sync.error.value).toBe('')
  })
  it('does not acknowledge or reuse another account’s queued event after a session switch', async () => {
    const sync = scope.run(() => useReadingEventSync(9, owner, receive))!
    await sync.persist(7, 5, reading())
    let finish: (value: Response) => void = () => undefined
    mockApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const sending = sync.flush()
    await vi.waitFor(() => expect(mockApi).toHaveBeenCalledOnce())
    owner.value = 8
    await nextTick()
    finish(response())
    await sending
    await sync.retry()
    expect(mockApi).toHaveBeenCalledOnce()
    expect(receive).not.toHaveBeenCalled()
    expect(await readingEventOutbox.pending(7, 9)).toHaveLength(1)
    expect(await readingEventOutbox.pending(8, 9)).toEqual([])
  })
  it('passes reset receipts to the reader without regenerating the original event', async () => {
    const original = reading()
    const sync = scope.run(() => useReadingEventSync(9, owner, receive))!
    await sync.persist(7, 5, original)
    mockApi.mockResolvedValueOnce(response('reset_required', 3))
    await sync.flush()
    expect(receive).toHaveBeenCalledWith({ outcome: 'reset_required', resetGeneration: 3, anchor: null })
    expect(original.event?.resetGeneration).toBe(2)
    expect(await readingEventOutbox.pending(7, 9)).toEqual([])
  })
})

import 'fake-indexeddb/auto'
import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadingAnchor } from '@bookorbit/types'
import { api } from '@/lib/api'
import { readingEventOutbox } from './reading-event-outbox'
import { holdReadingEventLock } from './reading-event-lock'
import { useReadingOutboxRecovery } from './useReadingOutboxRecovery'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const mockApi = vi.mocked(api)
const response = () => new Response(JSON.stringify({ outcome: 'accepted', resetGeneration: 2, anchor: null }), { status: 200 })

describe('closed-book reading recovery', () => {
  let scope: ReturnType<typeof effectScope>
  const owner = ref<number | null>(7)
  const held = new Set<string>()
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  const anchor = (fileId: number): ReadingAnchor => ({
    schemaVersion: 1,
    bookId: 2,
    bookFileId: fileId,
    revision: '95f66679-bff3-4f7e-a8c6-1d4cf246700a',
    chapterIndex: 0,
    chapterFraction: 0.2,
    bookFraction: 0.1,
    event: { id: crypto.randomUUID(), deviceId: 'reader', deviceSequence: fileId, occurredAt: '2026-09-05T13:00:00.000Z', resetGeneration: 2 },
  })
  beforeEach(() => {
    vi.clearAllMocks()
    held.clear()
    owner.value = 7
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        query: () => Promise.resolve({ held: [...held].map((name) => ({ name, mode: 'shared', clientId: 'another-tab' })), pending: [] }),
        request: async (name: string, options: LockOptions, callback: (lock: Lock | null) => unknown) => {
          if (options.ifAvailable && held.has(name)) return callback(null)
          held.add(name)
          try {
            return await callback({ name, mode: options.mode ?? 'exclusive' } as Lock)
          } finally {
            held.delete(name)
          }
        },
      },
    })
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
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
    vi.restoreAllMocks()
  })
  it('replays closed books while preserving an open reader’s event until it releases its shared lock', async () => {
    const reader = holdReadingEventLock(7, 9)
    await reader.ready
    await readingEventOutbox.put(7, 5, 10, anchor(10))
    await readingEventOutbox.put(7, 5, 9, anchor(9))
    await readingEventOutbox.put(8, 5, 11, anchor(11))
    mockApi.mockImplementation(() => Promise.resolve(response()))
    const recovery = scope.run(() => useReadingOutboxRecovery(owner))!
    try {
      await recovery.flush()
      expect(mockApi.mock.calls.map(([url]) => url)).toEqual(['/api/v1/libraries/5/files/10/reading-events'])
      expect(await readingEventOutbox.pending(7, 9)).toHaveLength(1)
      expect(await readingEventOutbox.pending(8, 11)).toHaveLength(1)
    } finally {
      reader.release()
    }
    await vi.waitFor(() => expect(held.size).toBe(0))
    await recovery.flush()
    expect(await readingEventOutbox.pending(7, 9)).toEqual([])
  })
  it('allows a reader to open during a slow upload and leaves acknowledgement to that reader', async () => {
    await readingEventOutbox.put(7, 5, 9, anchor(9))
    let finish: (value: Response) => void = () => undefined
    mockApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const recovery = scope.run(() => useReadingOutboxRecovery(owner))!
    const sending = recovery.flush()
    await vi.waitFor(() => expect(mockApi).toHaveBeenCalledOnce())
    const reader = holdReadingEventLock(7, 9)
    try {
      await reader.ready
      finish(response())
      await sending
      expect(await readingEventOutbox.pending(7, 9)).toHaveLength(1)
    } finally {
      reader.release()
    }
  })
  it('bounds each batch and isolates a denied file until explicit retry', async () => {
    for (let fileId = 100; fileId <= 120; fileId++) await readingEventOutbox.put(7, 5, fileId, anchor(fileId))
    mockApi.mockImplementation((url) => Promise.resolve(String(url).includes('/120/') ? new Response('{}', { status: 403 }) : response()))
    const recovery = scope.run(() => useReadingOutboxRecovery(owner))!
    await recovery.flush()
    expect(mockApi).toHaveBeenCalledTimes(20)
    expect(await readingEventOutbox.pending(7, 120)).toHaveLength(1)
    await recovery.flush()
    expect(mockApi).toHaveBeenCalledTimes(21)
    expect(await readingEventOutbox.pendingForUser(7, new Set())).toHaveLength(1)
    expect(recovery.error.value).toContain('could not synchronize')
    mockApi.mockImplementation(() => Promise.resolve(response()))
    await recovery.retry()
    expect(await readingEventOutbox.pendingForUser(7, new Set())).toEqual([])
    expect(recovery.error.value).toBe('')
  })
  it('does not replay another account’s queue after an in-flight session switch', async () => {
    await readingEventOutbox.put(7, 5, 9, anchor(9))
    let finish: (value: Response) => void = () => undefined
    mockApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const recovery = scope.run(() => useReadingOutboxRecovery(owner))!
    const sending = recovery.flush()
    await vi.waitFor(() => expect(mockApi).toHaveBeenCalledOnce())
    owner.value = 8
    await nextTick()
    finish(response())
    await sending
    await recovery.flush()
    expect(mockApi).toHaveBeenCalledOnce()
    expect(await readingEventOutbox.pending(7, 9)).toHaveLength(1)
    expect(JSON.parse(mockApi.mock.calls[0]![1]!.body as string).expectedUserId).toBe(7)
  })
})

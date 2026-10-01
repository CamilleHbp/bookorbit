import { effectScope, nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FanfictionSource } from '@bookorbit/types'
import { api } from '@/lib/api'
import { useFanfictionSourceBatch } from './useFanfictionSourceBatch'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const mockApi = vi.mocked(api)
const response = (value: unknown) => ({ ok: true, status: 200, json: async () => value }) as Response
const queued = {
  id: 'batch',
  kind: 'source_batch',
  state: 'queued',
  result: { selection: { action: 'update', processed: 0, failed: 0, finished: false } },
}

describe('durable bulk story controls', () => {
  let scope: ReturnType<typeof effectScope>
  const libraryId = ref<number | null>(5)
  const sources = ref([{ id: 'one' }, { id: 'two' }] as FanfictionSource[])
  const search = ref('Story')
  const filter = ref('paused')
  const completed = vi.fn<() => void>()
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    libraryId.value = 5
    sources.value = [{ id: 'one' }, { id: 'two' }] as FanfictionSource[]
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    mockApi.mockResolvedValue(response({ items: [], nextCursor: null }))
    scope = effectScope()
  })
  afterEach(() => {
    scope.stop()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  const create = () => scope.run(() => useFanfictionSourceBatch(libraryId, sources, search, filter, completed))!

  it('reuses an uncertain request and sends only the validated selection fields', async () => {
    const state = create()
    await flushPromises()
    state.selectPage()
    mockApi.mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValueOnce(response(queued))
    await state.start()
    await state.start()
    const calls = mockApi.mock.calls.filter(([url]) => String(url).endsWith('/source-batches'))
    expect(calls).toHaveLength(2)
    expect(calls[0]![1]!.body).toBe(calls[1]![1]!.body)
    expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({ action: 'update', ids: ['one', 'two'], idempotencyKey: expect.any(String) })
    expect(state.active.value).toBe(true)
    expect(state.canStart.value).toBe(false)
  })

  it('sends all matching filters with an explicit manual schedule and rejects sub-hour intervals', async () => {
    const state = create()
    await flushPromises()
    state.allMatching.value = true
    state.action.value = 'schedule'
    state.interval.value = '59'
    await state.start()
    expect(mockApi).toHaveBeenCalledTimes(1)
    state.interval.value = 'manual'
    mockApi.mockResolvedValueOnce(response(queued))
    await state.start()
    expect(JSON.parse(mockApi.mock.lastCall![1]!.body as string)).toEqual({
      action: 'schedule',
      allMatching: true,
      search: 'Story',
      state: 'paused',
      intervalMinutes: null,
      idempotencyKey: expect.any(String),
    })
  })

  it('recovers review results after navigation and replaces bounded failure pages', async () => {
    const reviewed = { ...queued, state: 'review_required', result: { selection: { action: 'update', processed: 100, failed: 30, finished: true } } }
    mockApi
      .mockResolvedValueOnce(response({ items: [reviewed], nextCursor: null }))
      .mockResolvedValueOnce(response({ items: [{ sourceId: 'first', title: 'First', errorCode: 'source_batch_item_failed' }], nextCursor: 'next' }))
    const state = create()
    await flushPromises()
    expect(mockApi.mock.calls[0]![0]).toBe('/api/v1/libraries/5/fanfiction/jobs?kind=source_batch&limit=1')
    expect(state.failures.value[0]?.sourceId).toBe('first')
    expect(completed).toHaveBeenCalledOnce()
    mockApi.mockResolvedValueOnce(response({ items: [{ sourceId: 'last', title: 'Last' }], nextCursor: null }))
    await state.moreFailures()
    expect(mockApi.mock.lastCall![0]).toContain('/failures?limit=25&cursor=next')
    expect(state.failures.value.map((item) => item.sourceId)).toEqual(['last'])
    mockApi.mockResolvedValueOnce(response(queued))
    await state.retry()
    expect(mockApi.mock.lastCall![0]).toBe('/api/v1/libraries/5/fanfiction/jobs/batch/retry')
    expect(mockApi.mock.lastCall![1]!.body).toBe('{}')
    expect(state.failures.value).toEqual([])
  })

  it('ignores an in-flight poll after cancellation starts', async () => {
    mockApi.mockResolvedValueOnce(response({ items: [queued] }))
    const state = create()
    await flushPromises()
    let release!: (value: Response) => void
    mockApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    await vi.advanceTimersByTimeAsync(3000)
    mockApi.mockResolvedValueOnce(response({ ...queued, state: 'cancelled' })).mockResolvedValueOnce(response({ ...queued, state: 'cancelled' }))
    await state.cancel()
    release(response(queued))
    await flushPromises()
    expect(state.job.value?.state).toBe('cancelled')
    expect(state.active.value).toBe(false)
  })

  it('aborts stale library requests and does not expose another library result', async () => {
    let release!: (value: Response) => void
    mockApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const state = create()
    const signal = mockApi.mock.calls[0]![1]!.signal
    libraryId.value = 6
    await nextTick()
    await flushPromises()
    expect(signal?.aborted).toBe(true)
    release(response({ items: [queued] }))
    await flushPromises()
    expect(state.job.value).toBeNull()
    expect(state.selectedIds.value).toEqual([])
  })

  it('pauses offline and recovers an interrupted initial request on reconnect', async () => {
    mockApi.mockRejectedValueOnce(new Error('Offline'))
    const state = create()
    await flushPromises()
    mockApi.mockResolvedValueOnce(response({ items: [queued] }))
    window.dispatchEvent(new Event('online'))
    await flushPromises()
    expect(state.active.value).toBe(true)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mockApi).toHaveBeenCalledTimes(2)
  })

  it('stops polling after bounded failures and lets the user explicitly retry', async () => {
    mockApi.mockResolvedValueOnce(response({ items: [queued] }))
    const state = create()
    await flushPromises()
    mockApi.mockRejectedValue(new Error('Unavailable'))
    await vi.advanceTimersByTimeAsync(300_000)
    expect(mockApi).toHaveBeenCalledTimes(6)
    mockApi.mockResolvedValueOnce(response({ ...queued, state: 'succeeded' }))
    await state.refresh()
    expect(state.job.value?.state).toBe('succeeded')
    expect(completed).toHaveBeenCalledOnce()
  })
})

import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FanfictionJob } from '@bookorbit/types'
import { api } from '@/lib/api'
import { useStoryLinkCompletion } from './useStoryLinkCompletion'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const mockApi = vi.mocked(api)
const response = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) }) as Response
const makeJob = (state: FanfictionJob['state'], failed = 0) => ({ id: 'link', state, result: { selection: { failed } } }) as FanfictionJob

describe('story linking completion', () => {
  let scope: ReturnType<typeof effectScope>
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    scope = effectScope()
  })
  afterEach(() => {
    scope.stop()
    vi.useRealTimers()
  })
  function setup() {
    const job = ref<FanfictionJob | null>(makeJob('queued'))
    const linked = vi.fn<() => void>()
    const model = scope.run(() => useStoryLinkCompletion(() => 5, job, linked))!
    return { job, linked, ...model }
  }
  it('polls to completion, refreshes the parent once, and stops polling', async () => {
    mockApi.mockResolvedValueOnce(response(makeJob('running'))).mockResolvedValueOnce(response(makeJob('succeeded')))
    const model = setup()
    await vi.advanceTimersByTimeAsync(3000)
    expect(model.job.value?.state).toBe('running')
    expect(mockApi.mock.calls[0]![0]).toBe('/api/v1/libraries/5/fanfiction/jobs/link')
    await vi.advanceTimersByTimeAsync(3000)
    expect(model.linked).toHaveBeenCalledOnce()
    expect(model.active.value).toBe(false)
    await vi.advanceTimersByTimeAsync(12000)
    expect(mockApi).toHaveBeenCalledTimes(2)
  })
  it.each(['failed', 'cancelled', 'configuration_blocked', 'review_required', 'succeeded'] as const)(
    'does not report a successful link for %s with failed candidates',
    async (state) => {
      mockApi.mockResolvedValueOnce(response(makeJob(state, 1)))
      const model = setup()
      await vi.advanceTimersByTimeAsync(3000)
      expect(model.failed.value).toBe(true)
      expect(model.linked).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(9000)
      expect(mockApi).toHaveBeenCalledOnce()
    },
  )
  it('keeps polling after a connection failure and clears the warning on recovery', async () => {
    mockApi.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(response(makeJob('succeeded')))
    const model = setup()
    await vi.advanceTimersByTimeAsync(3000)
    expect(model.statusUnavailable.value).toBe(true)
    expect(model.active.value).toBe(true)
    await model.refresh()
    await nextTick()
    expect(model.statusUnavailable.value).toBe(false)
    expect(model.linked).toHaveBeenCalledOnce()
  })
  it('discards an in-flight response after leaving the book', async () => {
    let resolve!: (value: Response) => void
    mockApi.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    )
    const model = setup()
    await vi.advanceTimersByTimeAsync(3000)
    scope.stop()
    resolve(response(makeJob('succeeded')))
    await vi.advanceTimersByTimeAsync(9000)
    expect(model.linked).not.toHaveBeenCalled()
    expect(model.job.value?.state).toBe('queued')
    expect(mockApi).toHaveBeenCalledOnce()
  })
})

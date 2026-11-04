import { effectScope, ref, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useImportInbox } from './useImportInbox'
import type { FanfictionJob } from '@bookorbit/types'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const response = (value: unknown) => new Response(JSON.stringify(value))
const job = {
  id: 'saved',
  kind: 'import',
  state: 'failed',
  result: { importReview: { approved: true, values: { tags: ['custom.tag'] } } },
} as FanfictionJob
const settle = async () => {
  await vi.waitFor(() => expect(state.busy.value).toBe(false))
}
let scope: ReturnType<typeof effectScope>
let state: ReturnType<typeof useImportInbox>
beforeEach(() => {
  vi.clearAllMocks()
  scope = effectScope()
})
afterEach(() => scope.stop())

describe('unfinished import inbox', () => {
  it('loads persisted imports independently of history and retries the same saved job', async () => {
    vi.mocked(api).mockResolvedValueOnce(response({ items: [job], nextCursor: null }))
    state = scope.run(() => useImportInbox(ref(1)))!
    await settle()
    expect(String(vi.mocked(api).mock.calls[0]![0])).toContain('pendingImportsOnly=true&limit=20')
    expect(state.jobs.value[0]?.result?.importReview?.values.tags).toEqual(['custom.tag'])
    vi.mocked(api).mockResolvedValueOnce(response({ ...job, state: 'queued' }))
    await state.retry(state.jobs.value[0]!)
    expect(api).toHaveBeenLastCalledWith('/api/v1/libraries/1/fanfiction/jobs/saved/retry', expect.objectContaining({ method: 'POST', body: '{}' }))
    expect(state.jobs.value[0]?.result).toEqual(job.result)
  })
  it('keeps the current page and saved edits when the next page or retry fails', async () => {
    vi.mocked(api).mockResolvedValueOnce(response({ items: [job], nextCursor: 'next' }))
    state = scope.run(() => useImportInbox(ref(1)))!
    await settle()
    vi.mocked(api).mockRejectedValueOnce(new Error('Offline'))
    await state.next()
    expect(state.page.value).toBe(1)
    expect(state.jobs.value[0]?.id).toBe('saved')
    vi.mocked(api).mockRejectedValueOnce(new Error('Offline'))
    await state.retry(job)
    expect(state.error.value).toBe(true)
    expect(state.jobs.value[0]?.result).toEqual(job.result)
  })
  it('replaces pages rather than growing the list and supports going back', async () => {
    vi.mocked(api).mockResolvedValueOnce(response({ items: [job], nextCursor: 'next' }))
    state = scope.run(() => useImportInbox(ref(1)))!
    await settle()
    vi.mocked(api).mockResolvedValueOnce(response({ items: [{ ...job, id: 'second' }], nextCursor: null }))
    await state.next()
    expect(state.jobs.value.map((item) => item.id)).toEqual(['second'])
    expect(state.page.value).toBe(2)
    vi.mocked(api).mockResolvedValueOnce(response({ items: [job], nextCursor: 'next' }))
    await state.previous()
    expect(state.jobs.value[0]?.id).toBe('saved')
  })
  it('ignores an old library response after switching libraries', async () => {
    let finish!: (value: Response) => void
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const library = ref(1)
    state = scope.run(() => useImportInbox(library))!
    vi.mocked(api).mockResolvedValueOnce(response({ items: [], nextCursor: null }))
    library.value = 2
    await nextTick()
    await settle()
    finish(response({ items: [job], nextCursor: 'old' }))
    await nextTick()
    expect(state.jobs.value).toEqual([])
    expect(state.nextCursor.value).toBeNull()
  })
})

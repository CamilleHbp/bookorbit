import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useFanfictionDiscovery } from './useFanfictionDiscovery'
vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const mockApi = vi.mocked(api)
const response = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response
const candidate = { id: 'candidate', bookId: 4, bookFileId: 7, title: 'Story', state: 'pending', urls: [] }
describe('existing story discovery UI contracts', () => {
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
  const model = () => scope.run(() => useFanfictionDiscovery(5))!
  it('reuses the exact selection after an uncertain response and locks its inputs', async () => {
    const view = model()
    view.selected.value = ['candidate']
    mockApi.mockRejectedValueOnce(new Error('Connection lost'))
    await view.review('approve', 'profile', 'manual')
    expect(view.locked.value).toBe(true)
    const original = mockApi.mock.calls[0]!
    expect(original[0]).toBe('/api/v1/libraries/5/fanfiction/discovery/selection')
    expect(JSON.parse(original[1]!.body as string)).toEqual({
      idempotencyKey: expect.any(String),
      decision: 'approve',
      state: 'pending',
      ids: ['candidate'],
      profileId: 'profile',
      intervalMinutes: null,
    })
    mockApi.mockResolvedValueOnce(response({ id: 'job', kind: 'adopt', state: 'queued' }))
    await view.submitPending()
    expect(mockApi.mock.calls[1]).toEqual(original)
    expect(view.pending.value).toBeNull()
    expect(view.active.value).toBe(true)
  })
  it('unlocks selection after a definitive rejection so the user can correct it', async () => {
    const view = model()
    view.selected.value = ['candidate']
    mockApi.mockResolvedValueOnce({ ok: false, status: 400, json: () => Promise.resolve({ message: 'Invalid profile' }) } as Response)
    await view.review('approve', 'bad-profile', 'manual')
    expect(view.pending.value).toBeNull()
    expect(view.locked.value).toBe(false)
    expect(view.error.value).toBe('Invalid profile')
  })
  it('uses server-side all-matching selection without loading every candidate', async () => {
    const view = model()
    view.allMatching.value = true
    mockApi.mockResolvedValueOnce(response({ id: 'job', state: 'queued' }))
    await view.review('approve', '', '1440')
    expect(JSON.parse(mockApi.mock.calls[0]![1]!.body as string)).toEqual({
      idempotencyKey: expect.any(String),
      decision: 'approve',
      state: 'pending',
      allMatching: true,
      profileId: null,
      intervalMinutes: 1440,
    })
    expect(mockApi).toHaveBeenCalledOnce()
  })
  it('requires a single explicit choice for ambiguous source evidence', async () => {
    const view = model()
    view.state.value = 'ambiguous'
    view.selected.value = ['candidate']
    await view.review('approve', '', '1440')
    expect(mockApi).not.toHaveBeenCalled()
    view.choices.value.candidate = 'https://archiveofourown.org/works/123'
    mockApi.mockResolvedValueOnce(response({ id: 'job', state: 'queued' }))
    await view.review('approve', '', '1440')
    expect(JSON.parse(mockApi.mock.calls[0]![1]!.body as string)).toMatchObject({
      canonicalUrl: 'https://archiveofourown.org/works/123',
      ids: ['candidate'],
    })
  })
  it('replaces pages and clears selections instead of growing a library-sized list', async () => {
    const view = model()
    mockApi.mockResolvedValueOnce(response({ items: [candidate], nextCursor: 'cursor' }))
    await view.refresh()
    view.selectPage()
    expect(view.selected.value).toEqual(['candidate'])
    mockApi.mockResolvedValueOnce(response({ items: [{ ...candidate, id: 'next' }], nextCursor: null }))
    await view.nextPage()
    expect(view.items.value.map((item) => item.id)).toEqual(['next'])
    expect(view.selected.value).toEqual([])
    expect(mockApi.mock.calls[1]![0]).toBe('/api/v1/libraries/5/fanfiction/discovery?limit=50&state=pending&cursor=cursor')
  })
  it('recovers a durable operation and polls through connection failure to completion', async () => {
    const view = model()
    mockApi
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(response({ items: [{ id: 'scan', kind: 'discovery', state: 'running', createdAt: '2026-01-01' }] }))
      .mockResolvedValueOnce(response({ items: [] }))
    await view.recover()
    expect(view.active.value).toBe(true)
    mockApi.mockRejectedValueOnce(new Error('offline'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(view.error.value).toBe('offline')
    mockApi
      .mockResolvedValueOnce(response({ id: 'scan', kind: 'discovery', state: 'succeeded' }))
      .mockResolvedValueOnce(response({ items: [candidate], nextCursor: null }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(view.active.value).toBe(false)
    expect(view.items.value).toHaveLength(1)
  })
  it('ignores a late response after changing library by disposing the old screen', async () => {
    const view = model()
    let resolve!: (value: Response) => void
    mockApi.mockReturnValueOnce(
      new Promise<Response>((done) => {
        resolve = done
      }),
    )
    const loading = view.refresh()
    scope.stop()
    resolve(response({ items: [candidate], nextCursor: null }))
    await loading
    expect(view.items.value).toEqual([])
  })
})

import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useBookStory } from './useBookStory'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const mockApi = vi.mocked(api)
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: () => Promise.resolve(body) }) as Response
const source = {
  id: 'story',
  libraryId: 5,
  bookId: 7,
  bookFileId: 9,
  title: 'Story',
  version: 2,
  state: 'active',
  profileId: null,
  intervalMinutes: 1440,
}
describe('book story administration', () => {
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
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await nextTick()
  }
  function pages(url: string) {
    if (url.includes('/sources?')) return response({ items: [source], nextCursor: null })
    if (url.includes('/revisions?'))
      return response({ items: [{ revision: 'previous', canRollback: true }], currentRevisionId: 'current', nextCursor: null })
    return response({ items: [], nextCursor: null })
  }
  it('requires both the feature permission and successful library administration access', async () => {
    const permitted = ref(false)
    const model = scope.run(() => useBookStory(7, 5, permitted))!
    await flush()
    expect(mockApi).not.toHaveBeenCalled()
    expect(model.allowed.value).toBe(false)
    mockApi.mockResolvedValue(response({}, 403))
    permitted.value = true
    await flush()
    expect(model.allowed.value).toBe(false)
    expect(mockApi.mock.calls[0]?.[0]).toBe('/api/v1/libraries/5/fanfiction/sources?bookId=7&limit=50')
  })
  it('sends exact rollback identities and reuses them after an uncertain response', async () => {
    mockApi.mockImplementation((url) => Promise.resolve(pages(String(url))))
    const model = scope.run(() => useBookStory(7, 5, true))!
    await flush()
    await model.refresh()
    expect(model.allowed.value).toBe(true)
    mockApi.mockRejectedValueOnce(new Error('Connection interrupted'))
    await model.rollback(model.revisions.value[0]!)
    const first = mockApi.mock.calls.at(-1)!
    mockApi.mockResolvedValueOnce(response({ id: 'rollback-job', kind: 'rollback', state: 'queued' }))
    await model.rollback(model.revisions.value[0]!)
    const second = mockApi.mock.calls.at(-1)!
    expect(first[0]).toBe('/api/v1/libraries/5/fanfiction/sources/story/rollback')
    expect(first[1]?.body).toBe(second[1]?.body)
    expect(JSON.parse(second[1]?.body as string)).toEqual({
      idempotencyKey: expect.any(String),
      revisionId: 'previous',
      expectedRevisionId: 'current',
    })
  })
  it('keeps schedule, profile, and unlink requests within the validated source DTO', async () => {
    mockApi.mockImplementation((url) => Promise.resolve(pages(String(url))))
    const model = scope.run(() => useBookStory(7, 5, true))!
    await flush()
    model.interval.value = 'manual'
    model.profileId.value = 'profile-id'
    await model.updateSettings()
    const patch = mockApi.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(JSON.parse(patch[1]!.body as string)).toEqual({ version: 2, profileId: 'profile-id', intervalMinutes: null })
    await model.unlink()
    expect(mockApi.mock.calls.filter(([, init]) => init?.method === 'PATCH').at(-1)?.[1]?.body).toBe(
      JSON.stringify({ version: 2, state: 'unlinked' }),
    )
  })
  it('requires a saved destination profile before exposing update controls after a library move', async () => {
    let needsProfile = true
    mockApi.mockImplementation((url, init) => {
      if (init?.method === 'PATCH') {
        needsProfile = false
      }
      return Promise.resolve(
        String(url).includes('/sources?')
          ? response({
              items: [{ ...source, state: 'paused', attentionCode: needsProfile ? 'destination_profile_required' : null }],
              nextCursor: null,
            })
          : pages(String(url)),
      )
    })
    const model = scope.run(() => useBookStory(7, 5, true))!
    await flush()
    expect(model.canUpdate.value).toBe(false)
    await model.updateSettings()
    expect(model.canUpdate.value).toBe(true)
    const patch = mockApi.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(JSON.parse(patch[1]!.body as string)).toEqual({ version: 2, profileId: null, intervalMinutes: 1440 })
  })
})

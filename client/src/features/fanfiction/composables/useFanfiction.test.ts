import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useFanfiction } from './useFanfiction'
import type { FanfictionSource } from '@bookorbit/types'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const mockApi = vi.mocked(api)
const response = (value: unknown) => ({ ok: true, status: 200, json: async () => value }) as Response
const preview = {
  canonicalUrl: 'https://archiveofourown.org/works/123',
  site: 'archiveofourown.org',
  title: 'A story',
  authors: ['Writer'],
  chapterCount: 10,
  status: 'In-Progress',
  description: '',
  tags: [],
}
const completedPreview = { id: 'preview-job', kind: 'preview', state: 'succeeded', result: { preview } }

describe('managed Fanfiction page requests', () => {
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
  const create = () => scope.run(() => useFanfiction())!
  it('previews matching sources and imports only after explicit confirmation', async () => {
    const state = create()
    state.libraryId.value = 5
    state.folderId.value = 8
    state.urls.value = 'https://fiction.live/stories/a/id\nhttps://archiveofourown.org/works/123'
    mockApi.mockImplementation(async (url) =>
      String(url).includes('profile-match')
        ? response({ profile: String(url).includes('archiveofourown') ? { id: 'ao3-profile' } : null })
        : response(completedPreview),
    )
    await state.reviewStories()
    const requests = mockApi.mock.calls.filter(([url]) => String(url).endsWith('/previews')).map(([, options]) => JSON.parse(options!.body as string))
    expect(requests).toHaveLength(2)
    expect(requests[0]).not.toHaveProperty('profileId')
    expect(requests[1].profileId).toBe('ao3-profile')
    expect(mockApi.mock.calls.some(([url]) => String(url).endsWith('/sources'))).toBe(false)
    state.dismissReview()
    expect(state.reviewCandidate.value).toBe(state.candidates.value[1])
    mockApi.mockResolvedValue(response({ id: 'import-job', kind: 'import', state: 'queued' }))
    await state.confirmReview({ title: 'Edited title', tags: [] })
    expect(JSON.parse(mockApi.mock.lastCall![1]!.body as string)).toEqual({
      url: preview.canonicalUrl,
      folderId: 8,
      intervalMinutes: 1440,
      profileId: 'ao3-profile',
      idempotencyKey: expect.any(String),
      metadata: { title: 'Edited title', tags: [] },
    })
    expect(state.reviewCandidate.value).toBeUndefined()
    state.reopenReview(state.candidates.value[0]!)
    expect(state.reviewCandidate.value).toBe(state.candidates.value[0])
  })

  it('retains confirmed edits and request identity after an uncertain import', async () => {
    const state = create()
    state.libraryId.value = 5
    state.folderId.value = 8
    state.profileId.value = 'chosen-profile'
    state.urls.value = preview.canonicalUrl
    mockApi.mockResolvedValueOnce(response(completedPreview))
    await state.reviewStories()
    mockApi.mockRejectedValueOnce(new Error('Disconnected'))
    await state.confirmReview({ title: 'My title' })
    expect(state.reviewCandidate.value).toBeDefined()
    state.folderId.value = 9
    state.profileId.value = 'another-profile'
    mockApi.mockResolvedValueOnce(response({ id: 'job', kind: 'import', state: 'queued' }))
    await state.confirmReview({ title: 'Different title' })
    expect(mockApi.mock.calls[1]?.[1]?.body).toBe(mockApi.mock.calls[2]?.[1]?.body)
  })

  it('retries a blocked preview with saved credentials before confirmation', async () => {
    const state = create()
    state.libraryId.value = 5
    state.folderId.value = 8
    state.profileId.value = 'old-profile'
    state.urls.value = preview.canonicalUrl
    mockApi.mockResolvedValueOnce(response({ id: 'job', kind: 'preview', state: 'configuration_blocked' }))
    await state.reviewStories()
    const key = state.candidates.value[0]!.previewKey
    mockApi.mockResolvedValueOnce(response(completedPreview))
    await state.retryImport(state.candidates.value[0]!, { id: 'new-profile', libraryId: 5, name: 'Login', version: 1, updatedAt: '' })
    expect(JSON.parse(mockApi.mock.calls[1]![1]!.body as string).profileId).toBe('new-profile')
    expect(state.candidates.value[0]!.previewKey).not.toBe(key)
    expect(state.reviewCandidate.value).toBeDefined()
    expect(mockApi.mock.calls.every(([url]) => String(url).endsWith('/previews'))).toBe(true)
  })

  it('keeps the same update request identity after an uncertain response and sends refresh separately', async () => {
    const state = create()
    state.libraryId.value = 5
    const source = { id: 'source-id', libraryId: 5 } as FanfictionSource
    mockApi.mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValue(response({ items: [], nextCursor: null }))
    await state.checkNow(source)
    await state.checkNow(source)
    expect(mockApi.mock.calls[0]?.[0]).toBe('/api/v1/libraries/5/fanfiction/sources/source-id/check')
    expect(mockApi.mock.calls[0]?.[1]?.body).toBe(mockApi.mock.calls[1]?.[1]?.body)
    expect(JSON.parse(mockApi.mock.calls[1]?.[1]?.body as string)).toEqual({ kind: 'update', idempotencyKey: expect.any(String) })
    await state.refreshChapters(source)
    expect(JSON.parse(mockApi.mock.calls[3]?.[1]?.body as string)).toEqual({ kind: 'refresh', idempotencyKey: expect.any(String) })
  })

  it('loads bounded, administrable library, folder, profile, source, and job pages', async () => {
    mockApi.mockImplementation(async (url) => {
      if (String(url).startsWith('/api/v1/fanfiction/libraries')) return response({ items: [{ id: 5, name: 'Stories' }], nextCursor: null })
      if (String(url).includes('/sources/folders')) return response({ items: [{ id: 8, path: '/books/stories' }], nextCursor: null })
      return response({ items: [], nextCursor: null })
    })
    const state = create()
    await state.loadLibraries()
    expect(state.libraryId.value).toBe(5)
    expect(state.folderId.value).toBe(8)
    expect(mockApi.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([
        '/api/v1/libraries/5/fanfiction/sources?limit=50',
        '/api/v1/libraries/5/fanfiction/jobs?limit=50',
        '/api/v1/libraries/5/fanfiction/activity?limit=50',
        '/api/v1/libraries/5/fanfiction/profiles?limit=50',
        '/api/v1/libraries/5/fanfiction/sources/folders?limit=50',
      ]),
    )
  })

  it('reuses a preview request after a connection failure and imports only validated DTO fields', async () => {
    const state = create()
    state.libraryId.value = 5
    state.folderId.value = 8
    state.urls.value = preview.canonicalUrl
    state.schedule.value = 'manual'
    state.profileId.value = 'chosen-profile'
    mockApi.mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValueOnce(response(completedPreview))
    await state.reviewStories()
    await state.reviewStories()
    expect(mockApi.mock.calls[0]?.[1]?.body).toBe(mockApi.mock.calls[1]?.[1]?.body)
    expect(state.reviewCandidate.value).toBeDefined()
    mockApi
      .mockResolvedValueOnce(response({ id: 'import-job', kind: 'import', state: 'queued' }))
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }))
    await state.confirmReview({})
    expect(mockApi.mock.calls[2]?.[0]).toBe('/api/v1/libraries/5/fanfiction/sources')
    expect(JSON.parse(mockApi.mock.calls[2]?.[1]?.body as string)).toEqual({
      url: preview.canonicalUrl,
      profileId: 'chosen-profile',
      folderId: 8,
      intervalMinutes: null,
      idempotencyKey: expect.any(String),
    })
    expect(state.reviewCandidate.value).toBeUndefined()
  })

  it('requires a fresh preview when the authentication profile changes', async () => {
    const state = create()
    state.libraryId.value = 5
    state.folderId.value = 8
    state.urls.value = preview.canonicalUrl
    state.profileId.value = 'initial-profile'
    mockApi.mockResolvedValue(response(completedPreview))
    await state.reviewStories()
    const key = state.candidates.value[0]?.previewKey
    state.profileId.value = 'new-profile'
    await state.reviewStories()
    expect(state.candidates.value[0]?.previewKey).not.toBe(key)
    expect(JSON.parse(mockApi.mock.calls[1]?.[1]?.body as string).profileId).toBe('new-profile')
  })

  it('rejects oversized URL batches before sending requests', async () => {
    const state = create()
    state.folderId.value = 8
    state.urls.value = Array.from({ length: 101 }, (_, index) => `https://example.org/story/${index}`).join('\n')
    await state.reviewStories()
    expect(mockApi).not.toHaveBeenCalled()
    expect(state.error.value).toContain('100')
  })

  it('ignores an old library response after switching to another library', async () => {
    let release!: (value: Response) => void
    const pending = new Promise<Response>((resolve) => {
      release = resolve
    })
    mockApi.mockImplementation(async (url) => {
      if (String(url) === '/api/v1/libraries/5/fanfiction/sources?limit=50') return pending
      if (String(url) === '/api/v1/libraries/6/fanfiction/sources?limit=50') return response({ items: [{ id: 'current-source' }], nextCursor: null })
      return response({ items: [], nextCursor: null })
    })
    const state = create()
    state.libraryId.value = 5
    const first = state.changeLibrary()
    state.libraryId.value = 6
    await state.changeLibrary()
    release(response({ items: [{ id: 'old-source' }], nextCursor: null }))
    await first
    expect(state.sources.value.map((source) => source.id)).toEqual(['current-source'])
  })
  it('selects an inline saved source and previews again with the updated settings', async () => {
    const state = create()
    state.libraryId.value = 5
    state.folderId.value = 8
    state.urls.value = preview.canonicalUrl
    state.profileId.value = 'initial-profile'
    mockApi.mockResolvedValue(response(completedPreview))
    await state.reviewStories()
    const oldKey = state.candidates.value[0]!.previewKey
    const profile = { id: 'saved-profile', libraryId: 5, name: 'AO3', version: 2, updatedAt: '' }
    state.useSavedProfile(profile)
    expect(state.profileId.value).toBe(profile.id)
    expect(state.urls.value).toBe(preview.canonicalUrl)
    expect(state.reviewCandidate.value).toBeUndefined()
    await state.reviewStories()
    expect(state.candidates.value[0]!.previewKey).not.toBe(oldKey)
    expect(JSON.parse(mockApi.mock.calls[1]![1]!.body as string).profileId).toBe(profile.id)
    state.useSavedProfile({ ...profile, id: 'other', libraryId: 6 })
    expect(state.profileId.value).toBe(profile.id)
  })
})

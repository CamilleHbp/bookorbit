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
  it('keeps bounded pages and lets users return without losing the active page on refresh', async () => {
    const state = create()
    state.libraryId.value = 5
    mockApi.mockImplementation(async (url) => {
      const next = String(url).includes('cursor=next')
      return response({ items: [{ id: next ? 'second' : 'first' }], nextCursor: next ? null : 'next' })
    })
    await state.refresh()
    await state.moreSources()
    expect(state.sources.value[0]?.id).toBe('second')
    expect(state.sourcePagination.number.value).toBe(2)
    await state.refresh()
    expect(state.sources.value[0]?.id).toBe('second')
    await state.previousSources()
    expect(state.sources.value[0]?.id).toBe('first')
    expect(state.sourcePagination.canPrevious.value).toBe(false)
    await state.moreJobs()
    await state.previousJobs()
    await state.moreActivity()
    await state.previousActivity()
    expect(state.jobPagination.number.value).toBe(1)
    expect(state.activityPagination.number.value).toBe(1)
  })

  it('does not advance history on failure and resets it only when filters are applied', async () => {
    const state = create()
    state.libraryId.value = 5
    mockApi.mockResolvedValue(response({ items: [], nextCursor: 'next' }))
    await state.refresh()
    mockApi.mockRejectedValueOnce(new Error('Offline'))
    await state.moreSources()
    expect(state.sourcePagination.number.value).toBe(1)
    await state.moreSources()
    state.search.value = 'dragon'
    await state.refresh()
    expect(String(mockApi.mock.calls.at(-3)?.[0])).not.toContain('dragon')
    await state.applyFilters()
    expect(String(mockApi.mock.calls.at(-1)?.[0])).toContain('search=dragon')
    expect(String(mockApi.mock.calls.at(-1)?.[0])).not.toContain('cursor=')
    expect(state.sourcePagination.number.value).toBe(1)
  })

  it('resumes a partially submitted batch without bringing back skipped duplicates', async () => {
    const state = create()
    state.libraryId.value = 5
    state.folderId.value = 8
    state.profileId.value = 'profile'
    state.urls.value = 'https://archiveofourown.org/works/1\nhttps://archiveofourown.org/works/2'
    mockApi
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ errorCode: 'story_exists', errorMeta: { id: '1', title: 'Existing' } }),
      } as Response)
      .mockRejectedValueOnce(new Error('Offline'))
    await state.importStories()
    state.cancelExistingStory()
    expect(state.importBatchCompleted.value).toBe(1)
    expect(state.importBatchFinished.value).toBe(false)
    state.startAnotherImportBatch()
    expect(state.importBatchStarted.value).toBe(true)
    mockApi.mockResolvedValueOnce(response({ id: 'import-2', kind: 'import', state: 'succeeded' }))
    await state.importStories()
    expect(mockApi).toHaveBeenCalledTimes(3)
    expect(JSON.parse(mockApi.mock.calls[2]![1]!.body as string).url).toBe('https://archiveofourown.org/works/2')
    expect(state.importBatchCompleted.value).toBe(2)
    expect(state.importBatchFinished.value).toBe(true)
    state.startAnotherImportBatch()
    expect(state.importBatchStarted.value).toBe(false)
    expect(state.urls.value).toBe('')
    expect(state.profileId.value).toBe('profile')
    expect(state.folderId.value).toBe(8)
  })

  it('loads more library choices without changing the selected library or clearing imports', async () => {
    const state = create()
    state.libraryId.value = 5
    state.libraries.value = [{ id: 5, name: 'Current' }]
    state.libraryCursor.value = 5
    state.urls.value = preview.canonicalUrl
    mockApi.mockResolvedValue(response({ items: [{ id: 6, name: 'Another' }], nextCursor: null }))
    await state.loadLibraries()
    expect(state.libraryId.value).toBe(5)
    expect(state.libraries.value.map((library) => library.id)).toEqual([5, 6])
    expect(state.urls.value).toBe(preview.canonicalUrl)
    expect(mockApi).toHaveBeenCalledTimes(1)
  })

  it('shows a submitted check immediately, prevents duplicate clicks, and polls its outcome', async () => {
    const state = create()
    state.libraryId.value = 5
    const source = { id: 'source-id', libraryId: 5 } as FanfictionSource
    let finish: (response: Response) => void = () => {}
    mockApi.mockImplementation(async (url) => {
      if (String(url).endsWith('/check'))
        return new Promise<Response>((resolve) => {
          finish = resolve
        })
      if (String(url).endsWith('/jobs/status')) return response({ items: [{ id: 'check', kind: 'update', state: 'no_change' }] })
      if (String(url).includes('/sources?')) return response({ items: [source], nextCursor: null })
      return response({ items: [], nextCursor: null })
    })
    const submitted = state.checkNow(source)
    expect(state.checkingSourceId.value).toBe(source.id)
    await state.checkNow(source)
    expect(mockApi).toHaveBeenCalledTimes(1)
    finish(response({ id: 'check', kind: 'update', state: 'queued' }))
    await submitted
    expect(state.sourceJobs.value[source.id]?.state).toBe('queued')
    expect(state.checkingSourceId.value).toBeNull()
    await state.checkNow(source)
    expect(mockApi.mock.calls.filter(([url]) => String(url).endsWith('/check'))).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.sourceJobs.value[source.id]?.state).toBe('no_change')
  })

  it('ignores a delayed check when the library changes', async () => {
    const state = create()
    state.libraryId.value = 5
    let finish: (response: Response) => void = () => {}
    mockApi.mockImplementation(async (url) =>
      String(url).endsWith('/check')
        ? new Promise<Response>((resolve) => {
            finish = resolve
          })
        : response({ items: [], nextCursor: null }),
    )
    const submitted = state.checkNow({ id: 'old', libraryId: 5 } as FanfictionSource)
    state.libraryId.value = 6
    await state.changeLibrary()
    finish(response({ id: 'old-job', state: 'queued' }))
    await submitted
    expect(state.sourceJobs.value).toEqual({})
    expect(state.checkingSourceId.value).toBeNull()
  })

  it('browses every duplicate and advances after resolving the current story', async () => {
    const state = create()
    state.libraryId.value = 5
    state.folderId.value = 8
    state.profileId.value = 'profile'
    state.urls.value = [1, 2, 3].map((id) => `https://archiveofourown.org/works/${id}`).join('\n')
    let id = 0
    mockApi.mockImplementation(
      async () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({
            errorCode: 'story_exists',
            errorMeta: { id: String(++id), title: `Story ${id}`, bookId: id, attentionCode: 'metadata_review_required' },
          }),
        }) as Response,
    )
    await state.importStories()
    expect(state.existingStoryCount.value).toBe(3)
    expect(state.hasPreviousExistingStory.value).toBe(false)
    state.nextExistingStory()
    expect(state.existingCandidate.value?.existingStory?.id).toBe('2')
    state.nextExistingStory()
    expect(state.hasNextExistingStory.value).toBe(false)
    state.previousExistingStory()
    state.cancelExistingStory()
    expect(state.existingCandidate.value?.existingStory?.id).toBe('3')
    state.cancelExistingStory()
    expect(state.existingCandidate.value?.existingStory?.id).toBe('1')
    state.cancelExistingStory()
    expect(state.existingStoryCount.value).toBe(0)
    expect(mockApi).toHaveBeenCalledTimes(3)
  })

  it('prepares duplicate updates while continuing new imports', async () => {
    const state = create()
    state.libraryId.value = 5
    state.folderId.value = 8
    state.profileId.value = 'profile'
    state.urls.value = preview.canonicalUrl + '\nhttps://archiveofourown.org/works/456'
    mockApi
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ errorCode: 'story_exists', errorMeta: { id: 'existing', title: 'A story' } }),
      } as Response)
      .mockResolvedValue(response({ id: 'new-job', kind: 'import', state: 'queued' }))
    await state.importStories()
    expect(state.error.value).toBe('')
    expect(state.existingCandidate.value).toBeUndefined()
    expect(state.visibleCandidates.value).toHaveLength(2)
    expect(mockApi).toHaveBeenCalledTimes(3)
    expect(String(mockApi.mock.calls[1]?.[0])).toContain('/sources/existing/check')
  })

  it('prepares an update when a running import resolves to an existing story', async () => {
    const state = create()
    state.libraryId.value = 5
    state.folderId.value = 8
    state.profileId.value = 'profile'
    state.urls.value = preview.canonicalUrl
    mockApi.mockResolvedValueOnce(response({ id: 'import-job', kind: 'import', state: 'queued' }))
    await state.importStories()
    mockApi.mockImplementation(async (url) =>
      String(url).endsWith('/check')
        ? response({ id: 'update-job', kind: 'update', state: 'queued' })
        : response({
            items: String(url).endsWith('/jobs/status')
              ? [
                  {
                    id: 'import-job',
                    kind: 'import',
                    state: 'succeeded',
                    result: { existingStory: { id: 'existing', title: 'A story' } },
                  },
                ]
              : [],
            nextCursor: null,
          }),
    )
    await vi.advanceTimersByTimeAsync(2000)
    expect(state.existingCandidate.value).toBeUndefined()
    expect(state.visibleCandidates.value[0]?.job?.kind).toBe('update')
  })

  it('retains stable update identity when automatic alias continuation loses its response', async () => {
    const state = create()
    state.libraryId.value = 5
    state.folderId.value = 8
    state.profileId.value = 'profile'
    state.urls.value = preview.canonicalUrl
    mockApi.mockResolvedValueOnce(
      response({
        id: 'import-job',
        kind: 'import',
        state: 'succeeded',
        result: { existingStory: { id: 'existing', title: 'A story' } },
      }),
    )
    mockApi.mockRejectedValueOnce(new Error('Disconnected'))
    await state.importStories()
    expect(state.visibleCandidates.value).toHaveLength(0)
    expect(state.existingCandidate.value).toBeDefined()
    mockApi.mockResolvedValueOnce(response({ id: 'update-job', kind: 'update', state: 'queued' }))
    await state.updateExistingStory()
    expect(mockApi.mock.calls[1]?.[0]).toBe('/api/v1/libraries/5/fanfiction/sources/existing/check')
    expect(mockApi.mock.calls[1]?.[1]?.body).toBe(mockApi.mock.calls[2]?.[1]?.body)
    expect(JSON.parse(mockApi.mock.calls[2]![1]!.body as string).kind).toBe('update')
    expect(JSON.parse(mockApi.mock.calls[2]![1]!.body as string).idempotencyKey).not.toBe(
      JSON.parse(mockApi.mock.calls[0]![1]!.body as string).idempotencyKey,
    )
    expect(state.existingCandidate.value).toBeUndefined()
    expect(state.visibleCandidates.value[0]?.job?.kind).toBe('update')
  })

  it('imports mixed sources directly using a matching profile for each URL', async () => {
    const state = create()
    state.libraryId.value = 5
    state.folderId.value = 8
    state.urls.value = 'https://fiction.live/stories/a/id\nhttps://archiveofourown.org/works/123'
    mockApi.mockImplementation(async (url) => {
      if (String(url).includes('profile-match')) return response({ profile: String(url).includes('archiveofourown') ? { id: 'ao3-profile' } : null })
      return response({ id: crypto.randomUUID(), kind: 'import', state: 'queued' })
    })
    await state.importStories()
    const imports = mockApi.mock.calls.filter(([url]) => String(url).endsWith('/sources')).map(([, options]) => JSON.parse(options!.body as string))
    expect(imports).toHaveLength(2)
    expect(imports[0]).not.toHaveProperty('profileId')
    expect(imports[1].profileId).toBe('ao3-profile')
    expect(mockApi.mock.calls.some(([url]) => String(url).includes('/previews'))).toBe(false)
    await state.importStories()
    expect(mockApi.mock.calls.filter(([url]) => String(url).endsWith('/sources'))).toHaveLength(2)
  })

  it('retains profile, destination and request identity after an uncertain direct import', async () => {
    const state = create()
    state.libraryId.value = 5
    state.folderId.value = 8
    state.profileId.value = 'chosen-profile'
    state.urls.value = preview.canonicalUrl
    mockApi.mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValue(response({ id: 'job', kind: 'import', state: 'queued' }))
    await state.importStories()
    state.folderId.value = 9
    state.profileId.value = 'another-profile'
    await state.importStories()
    expect(mockApi.mock.calls[0]?.[1]?.body).toBe(mockApi.mock.calls[1]?.[1]?.body)
    expect(mockApi.mock.calls.every(([url]) => String(url).endsWith('/sources'))).toBe(true)
  })

  it('retries a blocked import with the saved profile and a new request identity', async () => {
    const state = create()
    state.libraryId.value = 5
    state.folderId.value = 8
    state.profileId.value = 'old-profile'
    state.urls.value = preview.canonicalUrl
    mockApi.mockResolvedValue(response({ id: 'job', kind: 'import', state: 'configuration_blocked', errorCode: 'authentication_required' }))
    await state.importStories()
    await state.retryImport(state.candidates.value[0]!, { id: 'new-profile', libraryId: 5, name: 'Login', version: 1, updatedAt: '' })
    const first = JSON.parse(mockApi.mock.calls[0]![1]!.body as string)
    const retry = JSON.parse(mockApi.mock.calls[1]![1]!.body as string)
    expect(retry.profileId).toBe('new-profile')
    expect(retry.idempotencyKey).not.toBe(first.idempotencyKey)
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
    mockApi.mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValueOnce(response(completedPreview))
    await state.previewStories()
    await state.previewStories()
    expect(mockApi.mock.calls[0]?.[1]?.body).toBe(mockApi.mock.calls[1]?.[1]?.body)
    expect(state.canImport.value).toBe(true)
    mockApi
      .mockResolvedValueOnce(response({ id: 'import-job', kind: 'import', state: 'queued' }))
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }))
    await state.importSelected()
    expect(mockApi.mock.calls[2]?.[0]).toBe('/api/v1/libraries/5/fanfiction/sources')
    expect(JSON.parse(mockApi.mock.calls[2]?.[1]?.body as string)).toEqual({
      url: preview.canonicalUrl,
      folderId: 8,
      intervalMinutes: null,
      idempotencyKey: expect.any(String),
    })
    expect(state.canImport.value).toBe(false)
  })

  it('requires a fresh preview when the authentication profile changes', async () => {
    const state = create()
    state.libraryId.value = 5
    state.folderId.value = 8
    state.urls.value = preview.canonicalUrl
    mockApi.mockResolvedValue(response(completedPreview))
    await state.previewStories()
    const key = state.candidates.value[0]?.previewKey
    state.profileId.value = 'new-profile'
    expect(state.canImport.value).toBe(false)
    await state.previewStories()
    expect(state.candidates.value[0]?.previewKey).not.toBe(key)
    expect(JSON.parse(mockApi.mock.calls[1]?.[1]?.body as string).profileId).toBe('new-profile')
  })

  it('rejects oversized URL batches before sending requests', async () => {
    const state = create()
    state.urls.value = Array.from({ length: 101 }, (_, index) => `https://example.org/story/${index}`).join('\n')
    await state.previewStories()
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
    mockApi.mockResolvedValue(response(completedPreview))
    await state.previewStories()
    const oldKey = state.candidates.value[0]!.previewKey
    const profile = { id: 'saved-profile', libraryId: 5, name: 'AO3', version: 2, updatedAt: '' }
    state.useSavedProfile(profile)
    expect(state.profileId.value).toBe(profile.id)
    expect(state.urls.value).toBe(preview.canonicalUrl)
    expect(state.canImport.value).toBe(false)
    await state.previewStories()
    expect(state.candidates.value[0]!.previewKey).not.toBe(oldKey)
    expect(JSON.parse(mockApi.mock.calls[1]![1]!.body as string).profileId).toBe(profile.id)
    state.useSavedProfile({ ...profile, id: 'other', libraryId: 6 })
    expect(state.profileId.value).toBe(profile.id)
  })
})

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
})

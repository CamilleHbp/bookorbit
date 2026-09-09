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
    vi.restoreAllMocks()
  })
  const flush = async () => {
    for (let i = 0; i < 16; i++) await Promise.resolve()
    await nextTick()
  }
  function pages(url: string) {
    if (url.includes('/sources?')) return response({ items: [source], nextCursor: null })
    if (url.includes('/revisions?'))
      return response({ items: [{ revision: 'previous', canRollback: true }], currentRevisionId: 'current', nextCursor: null })
    return response({ items: [], nextCursor: null })
  }
  it('uploads multipart bytes with stable request identity after an uncertain response', async () => {
    mockApi.mockImplementation((url) => Promise.resolve(pages(String(url))))
    const model = scope.run(() => useBookStory(7, 5, true))!
    await flush()
    const file = new File(['epub bytes'], 'story.epub', { type: 'application/epub+zip' })
    model.chooseReplacement({ target: { files: [file], value: 'story.epub' } } as unknown as Event)
    mockApi.mockRejectedValueOnce(new Error('Connection interrupted'))
    await model.uploadReplacement()
    const first = mockApi.mock.calls.at(-1)!
    expect(model.replacementFile.value).toBe(file)
    mockApi.mockResolvedValueOnce(response({ id: 'upload-job', kind: 'replacement', state: 'queued' }))
    await model.uploadReplacement()
    const second = mockApi.mock.calls.at(-1)!
    expect(second[0]).toBe(first[0])
    const url = new URL(String(second[0]), 'https://books.test')
    expect(url.pathname).toBe('/api/v1/libraries/5/fanfiction/sources/story/replacement')
    expect(url.searchParams.get('expectedRevisionId')).toBe('current')
    expect(url.searchParams.get('idempotencyKey')).toBeTruthy()
    expect(second[1]?.headers).toBeUndefined()
    expect(second[1]?.body).toBeInstanceOf(FormData)
    expect((second[1]!.body as FormData).get('file')).toBeInstanceOf(File)
    expect(model.replacementFile.value).toBeNull()
    expect(model.job.value?.id).toBe('upload-job')
  })
  it('recovers a reduction review and approves only its exact uploaded bytes and base revision', async () => {
    const review = { sha256: 'a'.repeat(64), expectedRevisionId: 'base-revision', identityMatches: true, previousChapterCount: 4, chapterCount: 3 }
    mockApi.mockImplementation((url) =>
      Promise.resolve(
        String(url).includes('kind=replacement')
          ? response({
              items: [
                {
                  id: 'review-job',
                  kind: 'replacement',
                  state: 'review_required',
                  errorCode: 'replacement_chapter_reduction',
                  result: { replacement: review },
                },
              ],
              nextCursor: null,
            })
          : pages(String(url)),
      ),
    )
    const model = scope.run(() => useBookStory(7, 5, true))!
    await flush()
    expect(model.canApproveReplacement.value).toBe(true)
    mockApi.mockResolvedValueOnce(response({ id: 'review-job', kind: 'replacement', state: 'queued' }))
    await model.approveReplacement()
    const call = mockApi.mock.calls.at(-1)!
    expect(call[0]).toBe('/api/v1/libraries/5/fanfiction/jobs/review-job/approve-replacement')
    expect(JSON.parse(call[1]?.body as string)).toEqual({ sha256: review.sha256, expectedRevisionId: review.expectedRevisionId })
  })
  it('rejects invalid uploads and clears a selected file when switching books', async () => {
    mockApi.mockImplementation((url) => Promise.resolve(pages(String(url))))
    const book = ref(7)
    const model = scope.run(() => useBookStory(book, 5, true))!
    await flush()
    model.chooseReplacement({ target: { files: [new File(['bad'], 'story.zip')], value: '' } } as unknown as Event)
    expect(model.replacementFile.value).toBeNull()
    expect(model.error.value).toContain('EPUB')
    model.chooseReplacement({ target: { files: [new File(['bytes'], 'story.epub')], value: '' } } as unknown as Event)
    book.value = 8
    await flush()
    expect(model.replacementFile.value).toBeNull()
  })
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
  it('keeps a retryable panel after a failed initial load while administration controls remain unavailable', async () => {
    mockApi.mockRejectedValueOnce(new Error('Connection interrupted'))
    const model = scope.run(() => useBookStory(7, 5, true))!
    await flush()
    expect(model.visible.value).toBe(true)
    expect(model.allowed.value).toBe(false)
    expect(model.error.value).toBe('Connection interrupted')
    mockApi.mockImplementation((url) => Promise.resolve(pages(String(url))))
    await model.refresh()
    expect(model.allowed.value).toBe(true)
    expect(model.error.value).toBe('')
  })
  it('aborts previous book requests and ignores their late access-denied responses', async () => {
    let finish: (value: Response) => void = () => undefined
    mockApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const currentBook = ref(7)
    const model = scope.run(() => useBookStory(currentBook, 5, true))!
    const signal = mockApi.mock.calls[0]![1]!.signal!
    mockApi.mockImplementation((url) => Promise.resolve(pages(String(url))))
    currentBook.value = 8
    await flush()
    expect(signal.aborted).toBe(true)
    expect(model.allowed.value).toBe(true)
    finish(response({}, 403))
    await flush()
    expect(model.allowed.value).toBe(true)
    expect(model.visible.value).toBe(true)
  })
  it('recovers the active source job after a page reload without queuing another operation', async () => {
    mockApi.mockImplementation((url) =>
      Promise.resolve(
        String(url).includes('/jobs?')
          ? response({ items: [{ id: 'existing-job', kind: 'update', state: 'running' }], nextCursor: null })
          : String(url).includes('/jobs/')
            ? response({ id: 'existing-job', kind: 'update', state: 'running' })
            : pages(String(url)),
      ),
    )
    const model = scope.run(() => useBookStory(7, 5, true))!
    await flush()
    expect(model.job.value?.id).toBe('existing-job')
    expect(mockApi.mock.calls.some(([url]) => url === '/api/v1/libraries/5/fanfiction/jobs?sourceId=story&activeOnly=true&limit=1')).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(mockApi.mock.calls.some(([url]) => String(url).endsWith('/jobs/existing-job'))).toBe(true)
    expect(mockApi.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })
  it('bounds repeated status failures and allows an explicit refresh to resume polling', async () => {
    let statusRequests = 0
    mockApi.mockImplementation((url) => {
      if (String(url).includes('/jobs?'))
        return Promise.resolve(response({ items: [{ id: 'existing-job', kind: 'update', state: 'running' }], nextCursor: null }))
      if (String(url).includes('/jobs/')) {
        statusRequests++
        return Promise.reject(new Error('Connection interrupted'))
      }
      return Promise.resolve(pages(String(url)))
    })
    const model = scope.run(() => useBookStory(7, 5, true))!
    await flush()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(statusRequests).toBe(5)
    expect(model.error.value).toBe('Connection interrupted')
    await vi.advanceTimersByTimeAsync(300_000)
    expect(statusRequests).toBe(5)
    await model.refresh()
    await vi.advanceTimersByTimeAsync(3000)
    expect(statusRequests).toBe(6)
  })
  it('pauses hidden and offline status checks without overlapping an in-flight request', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    let finish: (value: Response) => void = () => undefined
    let statusRequests = 0
    mockApi.mockImplementation((url) => {
      if (String(url).includes('/jobs?'))
        return Promise.resolve(response({ items: [{ id: 'existing-job', kind: 'update', state: 'running' }], nextCursor: null }))
      if (String(url).includes('/jobs/')) {
        statusRequests++
        return new Promise((resolve) => {
          finish = resolve
        })
      }
      return Promise.resolve(pages(String(url)))
    })
    scope.run(() => useBookStory(7, 5, true))!
    await flush()
    await vi.advanceTimersByTimeAsync(3000)
    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(6000)
    expect(statusRequests).toBe(1)
    finish(response({ id: 'existing-job', kind: 'update', state: 'running' }))
    await flush()
    online.mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(statusRequests).toBe(1)
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(statusRequests).toBe(2)
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
  it.each(['succeeded', 'no_change'])('refreshes book metadata when a story job ends with %s', async (state) => {
    const updated = vi.fn<(bookId: number) => void>()
    mockApi.mockImplementation((url, init) => {
      if (init?.method === 'POST') return Promise.resolve(response({ id: 'update-job', kind: 'update', state: 'queued' }))
      if (String(url).includes('/jobs/')) return Promise.resolve(response({ id: 'update-job', kind: 'update', state }))
      return Promise.resolve(pages(String(url)))
    })
    const model = scope.run(() => useBookStory(7, 5, true, updated))!
    await flush()
    await model.checkNow()
    expect(updated).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(updated).toHaveBeenCalledExactlyOnceWith(7)
    await vi.advanceTimersByTimeAsync(6000)
    expect(updated).toHaveBeenCalledTimes(1)
  })
  it('does not refresh another book after navigating during job completion', async () => {
    const updated = vi.fn<(bookId: number) => void>()
    const currentBook = ref(7)
    let finish: (value: Response) => void = () => undefined
    mockApi.mockImplementation((url, init) => {
      if (init?.method === 'POST') return Promise.resolve(response({ id: 'update-job', kind: 'update', state: 'queued' }))
      if (String(url).includes('/jobs/'))
        return new Promise((resolve) => {
          finish = resolve
        })
      return Promise.resolve(pages(String(url)))
    })
    const model = scope.run(() => useBookStory(currentBook, 5, true, updated))!
    await flush()
    await model.checkNow()
    await vi.advanceTimersByTimeAsync(3000)
    currentBook.value = 8
    await flush()
    finish(response({ id: 'update-job', kind: 'update', state: 'succeeded' }))
    await flush()
    expect(updated).not.toHaveBeenCalled()
    expect(model.job.value).toBeNull()
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

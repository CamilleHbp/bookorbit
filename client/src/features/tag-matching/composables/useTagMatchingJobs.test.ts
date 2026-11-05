import { effectScope } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTagMatchingJobs } from './useTagMatchingJobs'
import { api } from '@/lib/api'
vi.mock('@/lib/api', () => ({ api: vi.fn() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
const scopes: ReturnType<typeof effectScope>[] = []
const job = { id: 'preview-id', version: 3, state: 'ready', processed: 1, changed: 1, skipped: 0, error: null }
const page = (state = 'ready') => ({
  job: { ...job, state },
  items: [
    {
      change: {
        bookId: 1,
        title: 'Story',
        addedTags: ['canonical'],
        removedTags: [],
        addedGenres: [],
        removedGenres: [],
        lockedFields: [],
        unresolved: 0,
      },
      state: 'pending',
      overrideFields: [],
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
})
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status })
}
function setup() {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(useTagMatchingJobs)!
}
afterEach(() => {
  scopes.forEach((scope) => scope.stop())
  scopes.length = 0
  vi.resetAllMocks()
})
describe('tag matching previews', () => {
  it('requires a new preview after changing locked-field choices', async () => {
    const preview = setup()
    vi.mocked(api).mockResolvedValueOnce(response(job)).mockResolvedValueOnce(response(page()))
    await preview.initialize()
    expect(preview.canApply.value).toBe(true)
    preview.overrideTags.value = true
    expect(preview.canApply.value).toBe(false)
    vi.mocked(api).mockClear()
    await preview.apply()
    expect(api).not.toHaveBeenCalled()
  })
  it('does not offer application when a ready preview has no changes', async () => {
    const preview = setup()
    vi.mocked(api)
      .mockResolvedValueOnce(response({ ...job, changed: 0 }))
      .mockResolvedValueOnce(response({ ...page(), job: { ...job, changed: 0 } }))
    await preview.initialize()
    expect(preview.canApply.value).toBe(false)
    vi.mocked(api).mockClear()
    await preview.apply()
    expect(api).not.toHaveBeenCalled()
  })
  it('finishes preview generation without automatically applying it', async () => {
    const preview = setup()
    vi.mocked(api)
      .mockResolvedValueOnce(response({ ...job, state: 'previewing' }))
      .mockResolvedValueOnce(response(page('previewing')))
      .mockResolvedValueOnce(response(job))
      .mockResolvedValueOnce(response(page()))
    await preview.preview()
    expect(preview.job.value?.state).toBe('ready')
    expect(vi.mocked(api).mock.calls.map(([url]) => url)).not.toContain('/api/v1/tag-matching/jobs/preview-id/apply')
  })
  it('resumes an already approved update after returning to the view', async () => {
    const preview = setup()
    vi.mocked(api)
      .mockResolvedValueOnce(response({ ...job, state: 'running' }))
      .mockResolvedValueOnce(response(page('running')))
      .mockResolvedValueOnce(response({ ...job, state: 'completed' }))
      .mockResolvedValueOnce(response(page('completed')))
    await preview.initialize()
    expect(preview.job.value?.state).toBe('completed')
    expect(vi.mocked(api).mock.calls[2]?.[0]).toBe('/api/v1/tag-matching/jobs/preview-id/advance')
  })
  it('keeps a stale preview unapplied and asks for a new preview', async () => {
    const preview = setup()
    vi.mocked(api).mockResolvedValueOnce(response(job)).mockResolvedValueOnce(response(page()))
    await preview.initialize()
    vi.mocked(api).mockResolvedValueOnce(response({}, 409)).mockResolvedValueOnce(response(page()))
    await preview.apply()
    expect(preview.error.value).toBe('tagMatching.preview.stale')
    expect(preview.canApply.value).toBe(false)
  })
})

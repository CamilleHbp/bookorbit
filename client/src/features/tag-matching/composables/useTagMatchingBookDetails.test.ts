import { effectScope } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useTagMatchingBookDetails } from './useTagMatchingBookDetails'
vi.mock('@/lib/api', () => ({ api: vi.fn() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
const scopes: ReturnType<typeof effectScope>[] = []
function setup() {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => useTagMatchingBookDetails('preview-id', 42))!
}
afterEach(() => {
  scopes.forEach((scope) => scope.stop())
  scopes.length = 0
  vi.resetAllMocks()
})
it('loads details on demand and paginates without applying changes', async () => {
  const details = setup()
  expect(api).not.toHaveBeenCalled()
  const data = { total: 26, labels: [], protectedChanges: { addedTags: ['protected'], removedTags: [], addedGenres: [], removedGenres: [] } }
  vi.mocked(api).mockImplementation(async () => new Response(JSON.stringify(data)))
  await details.toggle()
  expect(details.hasProtectedChanges.value).toBe(true)
  expect(details.pages.value).toBe(2)
  await details.next()
  expect(vi.mocked(api).mock.calls.map(([url]) => url)).toEqual([
    '/api/v1/tag-matching/jobs/preview-id/books/42?page=1&pageSize=25',
    '/api/v1/tag-matching/jobs/preview-id/books/42?page=2&pageSize=25',
  ])
})
it('removes obsolete details and explains stale previews', async () => {
  const details = setup()
  vi.mocked(api).mockResolvedValue(new Response('{}', { status: 409 }))
  await details.toggle()
  expect(details.data.value).toBeNull()
  expect(details.error.value).toBe('tagMatching.preview.stale')
})

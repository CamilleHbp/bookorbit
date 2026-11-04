import { effectScope } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTagMatching } from './useTagMatching'
import { api } from '@/lib/api'
vi.mock('@/lib/api', () => ({ api: vi.fn() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
const scopes: ReturnType<typeof effectScope>[] = []
function setup() {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(useTagMatching)!
}
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}
afterEach(() => {
  scopes.forEach((scope) => scope.stop())
  scopes.length = 0
  vi.resetAllMocks()
})
describe('tag matching editor', () => {
  it('sends the existing rule ID when changing its source', async () => {
    const editor = setup()
    vi.mocked(api).mockResolvedValueOnce(response({ items: [], total: 0, version: 3 }))
    await editor.load()
    vi.mocked(api).mockClear()
    editor.edit({
      id: 'rule-id',
      source: null,
      field: 'tags',
      value: 'alias',
      bookCount: 2,
      targets: [{ field: 'tags', id: 1 }],
      targetNames: ['canonical'],
    })
    editor.draft.value![0]!.source = 'archiveofourown.org'
    vi.mocked(api)
      .mockResolvedValueOnce(response({ version: 4 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, version: 4 }))
    editor.saveMatch()
    await vi.waitFor(() => expect(editor.saving.value).toBe(false))
    expect(JSON.parse(vi.mocked(api).mock.calls[0]![1]!.body as string)).toMatchObject({ id: 'rule-id', source: 'archiveofourown.org', version: 3 })
  })
  it('keeps missing fandom decisions scoped to the affected book', async () => {
    const editor = setup()
    vi.mocked(api).mockResolvedValueOnce(response({ items: [], total: 0, version: 3 }))
    await editor.load()
    vi.mocked(api).mockClear()
    editor.edit({ bookId: 42, sourceKey: 'fanfiction:one', source: 'ao3', field: 'fandoms', value: 'A story', bookCount: 1 })
    vi.mocked(api)
      .mockResolvedValueOnce(response({ version: 3 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, version: 3 }))
    editor.ignore()
    await vi.waitFor(() => expect(editor.saving.value).toBe(false))
    expect(JSON.parse(vi.mocked(api).mock.calls[0]![1]!.body as string)).toMatchObject({
      bookId: 42,
      sourceKey: 'fanfiction:one',
      action: 'ignore',
      targets: [],
    })
    expect(editor.notice.value).toBe('tagMatching.decisionsSaved')
  })
  it('preserves the draft after a stale save and refreshes when cancelled', async () => {
    const editor = setup()
    vi.mocked(api).mockResolvedValueOnce(response({ items: [], total: 0, version: 3 }))
    await editor.load()
    vi.mocked(api).mockClear()
    editor.edit({ source: '', field: 'tags', value: 'alias', bookCount: 1 })
    vi.mocked(api).mockResolvedValueOnce(response({}, 409))
    editor.ignore()
    await vi.waitFor(() => expect(editor.saving.value).toBe(false))
    expect(editor.draft.value).toHaveLength(1)
    expect(editor.error.value).toBe('tagMatching.conflict')
    vi.mocked(api).mockResolvedValueOnce(response({ items: [], total: 0, version: 4 }))
    editor.cancel()
    await vi.waitFor(() => expect(editor.loading.value).toBe(false))
    expect(editor.draft.value).toBeNull()
  })
  it('keeps only unfinished decisions when a bulk request fails', async () => {
    const editor = setup()
    vi.mocked(api).mockResolvedValueOnce(response({ items: [], total: 0, version: 3 }))
    await editor.load()
    vi.mocked(api).mockClear()
    editor.rows.value = ['first', 'second'].map((value) => ({ source: 'file', field: 'tags', value, bookCount: 1 }))
    editor.rows.value.forEach(editor.toggle)
    editor.editSelected()
    vi.mocked(api)
      .mockResolvedValueOnce(response({ version: 4 }))
      .mockResolvedValueOnce(response({}, 500))
    editor.ignore()
    await vi.waitFor(() => expect(editor.saving.value).toBe(false))
    expect(editor.draft.value?.map((row) => row.value)).toEqual(['second'])
    expect(JSON.parse(vi.mocked(api).mock.calls[1]![1]!.body as string).version).toBe(4)
  })
})

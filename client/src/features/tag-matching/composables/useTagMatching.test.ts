import { effectScope, nextTick } from 'vue'
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
  vi.useRealTimers()
  vi.resetAllMocks()
})
describe('tag matching editor', () => {
  it('uses Enter to stage an exact result or a new name after search completes', async () => {
    vi.useFakeTimers()
    const editor = setup()
    editor.addRule()
    vi.mocked(api).mockImplementation(async () => response([{ id: 7, field: 'tags', name: 'A', score: 1 }]))
    const enter = () => editor.acceptTargetSearch(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    editor.targetSearch.value = ' a '
    await nextTick()
    enter()
    expect(editor.newTargets.value).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(editor.canCreateTarget.value).toBe(false)
    enter()
    expect(editor.targets.value).toEqual([{ field: 'tags', id: 7, name: 'A' }])
    editor.targetSearch.value = 'A new tag'
    await nextTick()
    await vi.advanceTimersByTimeAsync(100)
    expect(editor.canCreateTarget.value).toBe(true)
    enter()
    expect(editor.newTargets.value).toEqual([{ field: 'tags', name: 'A new tag' }])
    editor.targetSearch.value = 'a  NEW tag'
    await nextTick()
    expect(editor.canCreateTarget.value).toBe(false)
    enter()
    expect(editor.newTargets.value).toHaveLength(1)
  })
  it('returns suggestions after 100ms and reuses recent searches immediately', async () => {
    vi.useFakeTimers()
    const editor = setup()
    editor.edit({ source: '', field: 'tags', value: 'alias', bookCount: 1 })
    vi.mocked(api).mockImplementation(async () => response([{ id: 1, field: 'tags', name: 'fandom.harry-potter', score: 0.8 }]))
    editor.targetSearch.value = '  HARRY '
    await nextTick()
    expect(editor.suggestionsLoading.value).toBe(true)
    await vi.advanceTimersByTimeAsync(99)
    expect(api).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(editor.suggestions.value[0]?.name).toBe('fandom.harry-potter')
    expect(vi.mocked(api).mock.calls[0]?.[0]).toContain('search=harry&field=tags')
    editor.targetSearch.value = 'harry-p'
    await nextTick()
    expect(editor.suggestions.value).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    editor.targetSearch.value = 'harry'
    await nextTick()
    expect(editor.suggestionsLoading.value).toBe(false)
    expect(editor.suggestions.value).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(api).toHaveBeenCalledTimes(2)
    editor.targetField.value = 'genres'
    await nextTick()
    expect(editor.suggestions.value).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(vi.mocked(api).mock.calls[2]?.[0]).toContain('field=genres')
  })
  it('aborts obsolete searches and ignores their late results', async () => {
    vi.useFakeTimers()
    const editor = setup()
    editor.edit({ source: '', field: 'tags', value: 'alias', bookCount: 1 })
    let finishOld!: (value: Response) => void
    vi.mocked(api)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve
          }),
      )
      .mockResolvedValueOnce(response([{ id: 2, field: 'tags', name: 'new', score: 1 }]))
    editor.targetSearch.value = 'old'
    await nextTick()
    await vi.advanceTimersByTimeAsync(100)
    const signal = vi.mocked(api).mock.calls[0]![1]!.signal!
    editor.targetSearch.value = 'new'
    await nextTick()
    expect(signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    finishOld(response([{ id: 1, field: 'tags', name: 'old', score: 1 }]))
    await vi.advanceTimersByTimeAsync(0)
    expect(editor.suggestions.value.map((item) => item.name)).toEqual(['new'])
    expect(editor.suggestionsError.value).toBe('')
  })
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

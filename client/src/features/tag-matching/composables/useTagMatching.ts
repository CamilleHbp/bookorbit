import { computed, onScopeDispose, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'
import type { LabelField, LabelTarget, TagMatchingPage, TagMatchingRule, TagMatchingReviewItem, TagMatchingSuggestion } from '@bookorbit/types'
export type MatchingRow = Omit<TagMatchingReviewItem, 'source'> & { source: string | null } & Partial<
    Pick<TagMatchingRule, 'id' | 'targets' | 'targetNames'>
  >
export function useTagMatching() {
  const { t } = useI18n()
  const view = ref<'matches' | 'review' | 'ignored'>('review')
  const search = ref(''),
    source = ref(''),
    field = ref<LabelField | ''>('')
  const page = ref(1),
    total = ref(0),
    version = ref(0)
  const rows = ref<MatchingRow[]>([]),
    loading = ref(false),
    saving = ref(false),
    error = ref(''),
    notice = ref('')
  const selection = ref<string[]>([])
  const draft = ref<MatchingRow[] | null>(null)
  const targets = ref<Array<LabelTarget & { name: string }>>([])
  const newTargets = ref<Array<{ field: 'tags' | 'genres'; name: string }>>([])
  const targetSearch = ref(''),
    targetField = ref<'tags' | 'genres'>('tags')
  const suggestions = ref<TagMatchingSuggestion[]>([])
  const pages = computed(() => Math.max(1, Math.ceil(total.value / 25)))
  const controllers = new Set<AbortController>()
  let revision = 0,
    suggestionRevision = 0
  let timer: ReturnType<typeof setTimeout> | undefined, suggestTimer: ReturnType<typeof setTimeout> | undefined
  const key = (row: MatchingRow) => JSON.stringify([row.source ?? '', row.field, row.value, row.bookId ?? null, row.sourceKey ?? null])
  async function request<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
    const controller = new AbortController()
    controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 30000)
    try {
      const response = await api(`/api/v1/tag-matching/${path}`, {
        signal: controller.signal,
        ...(body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
      if (!response.ok) throw new Error(t(response.status === 409 ? 'tagMatching.conflict' : 'tagMatching.requestError'))
      return (await response.json()) as T
    } finally {
      clearTimeout(timeout)
      controllers.delete(controller)
    }
  }
  async function load() {
    const current = ++revision
    loading.value = true
    error.value = ''
    const query = new URLSearchParams({ page: String(page.value), pageSize: '25', search: search.value })
    if (source.value) query.set('source', source.value)
    if (field.value) query.set('field', field.value)
    if (view.value !== 'review') query.set('action', view.value === 'ignored' ? 'ignore' : 'match')
    try {
      const data = await request<TagMatchingPage<MatchingRow>>(`${view.value === 'review' ? 'review' : 'rules'}?${query}`)
      if (current !== revision) return
      rows.value = data.items
      total.value = data.total
      version.value = data.version
      selection.value = []
    } catch (cause) {
      if (current === revision) error.value = (cause as Error).message
    } finally {
      if (current === revision) loading.value = false
    }
  }
  function switchView(next: typeof view.value) {
    if (draft.value || saving.value) return
    view.value = next
    page.value = 1
    void load()
  }
  function previous() {
    if (page.value > 1) {
      page.value--
      void load()
    }
  }
  function next() {
    if (page.value < pages.value) {
      page.value++
      void load()
    }
  }
  function toggle(row: MatchingRow) {
    const id = key(row)
    selection.value = selection.value.includes(id) ? selection.value.filter((item) => item !== id) : [...selection.value, id]
  }
  function edit(row: MatchingRow) {
    draft.value = [{ ...row }]
    newTargets.value = []
    targetSearch.value = ''
    suggestions.value = []
    notice.value = ''
    targets.value = (row.targets ?? []).map((target, index) => ({ ...target, name: row.targetNames?.[index] ?? '' }))
  }
  function editSelected() {
    const selected = rows.value.filter((row) => selection.value.includes(key(row)))
    if (!selected.length) return
    edit(selected[0]!)
    draft.value = selected.map((row) => ({ ...row }))
    targets.value = []
  }
  function addRule() {
    edit({ source: '', field: 'tags', value: '', bookCount: 0 })
  }
  function cancel() {
    if (!saving.value) {
      draft.value = null
      error.value = ''
      void load()
    }
  }
  function addTarget(target: TagMatchingSuggestion) {
    if (!targets.value.some((item) => item.id === target.id && item.field === target.field))
      targets.value.push({ id: target.id, field: target.field, name: target.name })
    targetSearch.value = ''
    suggestions.value = []
  }
  function removeTarget(index: number) {
    targets.value.splice(index, 1)
  }
  function removeNewTarget(index: number) {
    newTargets.value.splice(index, 1)
  }
  function createTarget() {
    const name = targetSearch.value.trim()
    if (name && !newTargets.value.some((item) => item.name === name && item.field === targetField.value))
      newTargets.value.push({ field: targetField.value, name })
    targetSearch.value = ''
    suggestions.value = []
  }
  async function save(action: 'match' | 'ignore') {
    if (!draft.value || saving.value) return
    if (draft.value.some((row) => !row.value.trim()) || (action === 'match' && !targets.value.length && !newTargets.value.length)) {
      error.value = t('tagMatching.chooseTarget')
      return
    }
    saving.value = true
    error.value = ''
    const bookDecision = draft.value.some((row) => row.bookId)
    let completed = 0
    try {
      if (!version.value) version.value = (await request<{ version: number }>('initialize', {})).version
      for (const row of draft.value) {
        const result = await request<{ version: number }>(
          'rules',
          {
            id: row.id,
            ...(row.bookId ? { bookId: row.bookId, sourceKey: row.sourceKey } : {}),
            version: version.value,
            source: row.source ?? '',
            field: row.field,
            value: row.bookId ? 'missing-fandom' : row.value,
            action,
            targets: action === 'ignore' ? [] : targets.value.map(({ field, id }) => ({ field, id })),
            newTargets: action === 'ignore' ? [] : newTargets.value,
          },
          'PUT',
        )
        version.value = result.version
        completed++
      }
      draft.value = null
      notice.value = t(bookDecision ? 'tagMatching.decisionsSaved' : 'tagMatching.saved', { count: completed })
      await load()
    } catch (cause) {
      if (draft.value) draft.value = draft.value.slice(completed)
      error.value = (cause as Error).message
    } finally {
      saving.value = false
    }
  }
  function saveMatch() {
    void save('match')
  }
  function ignore() {
    void save('ignore')
  }
  watch([search, source, field], () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      page.value = 1
      void load()
    }, 300)
  })
  watch([targetSearch, targetField], () => {
    const current = ++suggestionRevision
    clearTimeout(suggestTimer)
    suggestions.value = []
    if (targetSearch.value.trim().length < 2) return
    suggestTimer = setTimeout(async () => {
      try {
        const data = await request<TagMatchingSuggestion[]>(
          `suggestions?${new URLSearchParams({ search: targetSearch.value, field: targetField.value })}`,
        )
        if (current === suggestionRevision) suggestions.value = data
      } catch (cause) {
        if (current === suggestionRevision) error.value = (cause as Error).message
      }
    }, 300)
  })
  onScopeDispose(() => {
    revision++
    suggestionRevision++
    clearTimeout(timer)
    clearTimeout(suggestTimer)
    controllers.forEach((controller) => controller.abort())
  })
  return {
    view,
    search,
    source,
    field,
    page,
    pages,
    total,
    rows,
    loading,
    saving,
    error,
    notice,
    selection,
    draft,
    targets,
    newTargets,
    targetSearch,
    targetField,
    suggestions,
    key,
    load,
    switchView,
    previous,
    next,
    toggle,
    edit,
    editSelected,
    addRule,
    cancel,
    addTarget,
    removeTarget,
    removeNewTarget,
    createTarget,
    saveMatch,
    ignore,
  }
}

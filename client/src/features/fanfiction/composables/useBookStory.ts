import { computed, onScopeDispose, ref, toValue, watch, type InjectionKey, type MaybeRefOrGetter, type Ref } from 'vue'
import type {
  BookFileRevisionPage,
  BookFileRevisionSummary,
  FanfictionJob,
  FanfictionProfilePage,
  FanfictionSource,
  FanfictionSourcePage,
} from '@bookorbit/types'
import { api } from '@/lib/api'

export const BOOK_STORY_ADMIN_KEY: InjectionKey<Ref<boolean>> = Symbol('book-story-administration')

export function useBookStory(
  bookId: MaybeRefOrGetter<number>,
  libraryId: MaybeRefOrGetter<number | undefined>,
  permitted: MaybeRefOrGetter<boolean>,
) {
  const allowed = ref(false)
  const loading = ref(false)
  const error = ref('')
  const sources = ref<FanfictionSource[]>([])
  const sourceCursor = ref<string | null>(null)
  const sourceId = ref('')
  const source = computed(() => sources.value.find((row) => row.id === sourceId.value) ?? null)
  const profiles = ref<FanfictionProfilePage['items']>([])
  const profileCursor = ref<string | null>(null)
  const profileId = ref('')
  const interval = ref('1440')
  const revisions = ref<BookFileRevisionSummary[]>([])
  const revisionCursor = ref<string | null>(null)
  const currentRevisionId = ref<string | null>(null)
  const job = ref<FanfictionJob | null>(null)
  const busy = ref(false)
  const base = computed(() => `/api/v1/libraries/${toValue(libraryId)}/fanfiction`)
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const requests = new Map<string, string>()
  const valid = (id: number) => id === generation && !disposed

  async function request<T>(url: string, body?: unknown, method = 'POST'): Promise<T> {
    const response = await api(
      url,
      body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
    const result = await response.json().catch(() => ({}))
    if (response.status === 403) allowed.value = false
    if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : `HTTP ${response.status}`)
    return result as T
  }
  async function perform(operation: (id: number) => Promise<void>) {
    const id = generation
    busy.value = true
    error.value = ''
    try {
      await operation(id)
    } catch (failure) {
      if (valid(id)) error.value = failure instanceof Error ? failure.message : 'Request failed'
    } finally {
      if (valid(id)) busy.value = false
    }
  }
  async function loadSources(id: number, cursor?: string) {
    const page = await request<FanfictionSourcePage>(`${base.value}/sources?bookId=${toValue(bookId)}&limit=50${cursor ? `&cursor=${cursor}` : ''}`)
    if (!valid(id)) return
    sources.value = page.items
    sourceCursor.value = page.nextCursor
    if (!page.items.some((row) => row.id === sourceId.value)) sourceId.value = page.items[0]?.id ?? ''
    profileId.value = source.value?.profileId ?? ''
    interval.value = source.value?.intervalMinutes === null ? 'manual' : String(source.value?.intervalMinutes ?? 1440)
  }
  async function loadHistory(id: number, cursor?: string) {
    const current = source.value
    if (!current?.bookFileId) return
    const page = await request<BookFileRevisionPage>(
      `/api/v1/libraries/${current.libraryId}/files/${current.bookFileId}/revisions?limit=25${cursor ? `&cursor=${cursor}` : ''}`,
    )
    if (!valid(id) || source.value?.id !== current.id) return
    revisions.value = page.items
    revisionCursor.value = page.nextCursor
    currentRevisionId.value = page.currentRevisionId ?? null
  }
  async function loadProfiles(id: number, cursor?: string) {
    const page = await request<FanfictionProfilePage>(`${base.value}/profiles?limit=50${cursor ? `&cursor=${cursor}` : ''}`)
    if (!valid(id)) return
    profiles.value = page.items
    profileCursor.value = page.nextCursor
  }
  async function refresh() {
    await perform(async (id) => {
      await loadSources(id)
      if (valid(id)) await Promise.all([loadHistory(id), loadProfiles(id)])
    })
  }
  async function selectSource() {
    profileId.value = source.value?.profileId ?? ''
    interval.value = source.value?.intervalMinutes === null ? 'manual' : String(source.value?.intervalMinutes ?? 1440)
    revisions.value = []
    revisionCursor.value = null
    currentRevisionId.value = null
    await perform((id) => loadHistory(id))
  }
  async function updateSettings() {
    await perform(async (id) => {
      const current = source.value
      if (!current) return
      const minutes = interval.value === 'manual' ? null : Number(interval.value)
      if (minutes !== null && (!Number.isInteger(minutes) || minutes < 60 || minutes > 525600))
        throw new Error('Use an interval between 60 and 525600 minutes.')
      await request(
        `${base.value}/sources/${current.id}`,
        { version: current.version, profileId: profileId.value || null, intervalMinutes: minutes },
        'PATCH',
      )
      if (valid(id)) await loadSources(id)
    })
  }
  async function setState(state: 'active' | 'paused' | 'unlinked') {
    await perform(async (id) => {
      const current = source.value
      if (!current) return
      await request(`${base.value}/sources/${current.id}`, { version: current.version, state }, 'PATCH')
      if (valid(id)) await loadSources(id)
    })
  }
  const pause = () => setState(source.value?.state === 'paused' ? 'active' : 'paused')
  const unlink = () => setState('unlinked')
  async function enqueue(kind: 'update' | 'refresh' | 'rollback', revisionId?: string) {
    await perform(async (id) => {
      const current = source.value
      if (!current) return
      const expectedRevisionId = currentRevisionId.value
      if (kind === 'rollback' && (!expectedRevisionId || !revisionId)) return
      const key = `${current.id}:${kind}:${revisionId ?? ''}:${kind === 'rollback' ? expectedRevisionId : ''}`
      const idempotencyKey = requests.get(key) ?? crypto.randomUUID()
      requests.set(key, idempotencyKey)
      const result = await request<FanfictionJob>(
        `${base.value}/sources/${current.id}/${kind === 'rollback' ? 'rollback' : 'check'}`,
        kind === 'rollback' ? { idempotencyKey, revisionId, expectedRevisionId } : { idempotencyKey, kind },
      )
      requests.delete(key)
      if (valid(id)) {
        job.value = result
        poll(id)
      }
    })
  }
  function poll(id: number) {
    clearTimeout(timer)
    if (!valid(id) || !job.value || !['queued', 'running'].includes(job.value.state)) return
    timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await request<FanfictionJob>(`${base.value}/jobs/${job.value!.id}`)
          if (!valid(id)) return
          job.value = result
          if (!['queued', 'running'].includes(result.state)) await refresh()
        } catch (failure) {
          if (valid(id)) error.value = failure instanceof Error ? failure.message : 'Request failed'
        } finally {
          poll(id)
        }
      })()
    }, 3000)
  }
  const checkNow = () => enqueue('update')
  const refreshChapters = () => enqueue('refresh')
  async function retryJob() {
    await perform(async (id) => {
      if (!job.value) return
      const result = await request<FanfictionJob>(`${base.value}/jobs/${job.value.id}/retry`, {})
      if (valid(id)) {
        job.value = result
        poll(id)
      }
    })
  }
  const rollback = (revision: BookFileRevisionSummary) => enqueue('rollback', revision.revision)
  const olderRevisions = () => perform((id) => loadHistory(id, revisionCursor.value ?? undefined))
  const moreProfiles = () => perform((id) => loadProfiles(id, profileCursor.value ?? undefined))
  const moreSources = () =>
    perform(async (id) => {
      await loadSources(id, sourceCursor.value ?? undefined)
      if (valid(id)) await loadHistory(id)
    })
  watch(
    () => [toValue(bookId), toValue(libraryId), toValue(permitted)],
    async () => {
      const id = ++generation
      clearTimeout(timer)
      allowed.value = false
      sources.value = []
      sourceId.value = ''
      revisions.value = []
      job.value = null
      error.value = ''
      loading.value = true
      if (!toValue(permitted) || toValue(libraryId) === undefined) {
        loading.value = false
        return
      }
      try {
        await loadSources(id)
        if (valid(id)) allowed.value = true
      } catch {
        /* An inaccessible administration panel stays hidden. */
      } finally {
        if (valid(id)) loading.value = false
      }
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    disposed = true
    generation++
    clearTimeout(timer)
  })
  return {
    allowed,
    loading,
    error,
    sources,
    sourceCursor,
    sourceId,
    source,
    profiles,
    profileCursor,
    profileId,
    interval,
    revisions,
    revisionCursor,
    currentRevisionId,
    job,
    busy,
    refresh,
    selectSource,
    updateSettings,
    pause,
    unlink,
    checkNow,
    refreshChapters,
    retryJob,
    rollback,
    olderRevisions,
    moreProfiles,
    moreSources,
  }
}

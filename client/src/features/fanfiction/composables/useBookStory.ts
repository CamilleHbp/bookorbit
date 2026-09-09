import { computed, onScopeDispose, ref, shallowRef, toValue, watch, type InjectionKey, type MaybeRefOrGetter, type Ref } from 'vue'
import type {
  BookFileRevisionPage,
  BookFileRevisionSummary,
  FanfictionJob,
  FanfictionJobPage,
  FanfictionProfilePage,
  FanfictionSource,
  FanfictionSourcePage,
} from '@bookorbit/types'
import { api } from '@/lib/api'

export const BOOK_STORY_ADMIN_KEY: InjectionKey<Ref<boolean>> = Symbol('book-story-administration')

class StoryRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export function useBookStory(
  bookId: MaybeRefOrGetter<number>,
  libraryId: MaybeRefOrGetter<number | undefined>,
  permitted: MaybeRefOrGetter<boolean>,
  onBookUpdated?: (bookId: number) => void | Promise<void>,
) {
  const allowed = ref(false)
  const denied = ref(false)
  const visible = computed(() => toValue(permitted) && toValue(libraryId) !== undefined && !denied.value)
  const loading = ref(false)
  const error = ref('')
  const sources = ref<FanfictionSource[]>([])
  const sourceCursor = ref<string | null>(null)
  const sourceId = ref('')
  const source = computed(() => sources.value.find((row) => row.id === sourceId.value) ?? null)
  const profiles = ref<FanfictionProfilePage['items']>([])
  const profileCursor = ref<string | null>(null)
  const canUpdate = computed(
    () =>
      source.value !== null &&
      source.value?.attentionCode !== 'destination_profile_required' &&
      ['active', 'paused'].includes(source.value?.state ?? ''),
  )
  const profileId = ref('')
  const interval = ref('1440')
  const revisions = ref<BookFileRevisionSummary[]>([])
  const revisionCursor = ref<string | null>(null)
  const currentRevisionId = ref<string | null>(null)
  const job = ref<FanfictionJob | null>(null)
  const busy = ref(false)
  const replacementFile = shallowRef<File | null>(null)
  const replacementKeys = new WeakMap<File, Map<string, string>>()
  const canReplace = computed(() => allowed.value && !!source.value?.bookFileId && source.value.state !== 'unlinked' && !!currentRevisionId.value)
  const canApproveReplacement = computed(
    () =>
      job.value?.kind === 'replacement' &&
      job.value.state === 'review_required' &&
      job.value.errorCode === 'replacement_chapter_reduction' &&
      job.value.result?.replacement?.identityMatches === true,
  )
  const base = computed(() => `/api/v1/libraries/${toValue(libraryId)}/fanfiction`)
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let failures = 0
  let pollingBlocked = false
  let polling: { generation: number; jobId: string } | null = null
  const inFlight = new Set<AbortController>()
  const requests = new Map<string, string>()
  const valid = (id: number) => id === generation && !disposed

  async function request<T>(url: string, body?: unknown, method = 'POST'): Promise<T> {
    const id = generation
    const controller = new AbortController()
    inFlight.add(controller)
    const timeout = setTimeout(() => controller.abort(), body instanceof FormData ? 180_000 : 20_000)
    try {
      const response = await api(url, {
        signal: controller.signal,
        ...(body === undefined
          ? {}
          : body instanceof FormData
            ? { method, body }
            : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const result = await response.json().catch(() => ({}))
      if ([401, 403].includes(response.status) && valid(id)) {
        allowed.value = false
        denied.value = true
      }
      if (!response.ok) throw new StoryRequestError(typeof result.message === 'string' ? result.message : `HTTP ${response.status}`, response.status)
      return result as T
    } finally {
      clearTimeout(timeout)
      inFlight.delete(controller)
    }
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
    allowed.value = true
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
    if (!visible.value) return
    failures = 0
    pollingBlocked = false
    await perform(async (id) => {
      await loadSources(id)
      if (valid(id)) await Promise.all([loadHistory(id), loadProfiles(id), recoverJob(id)])
    })
    poll(generation)
  }
  async function recoverJob(id: number) {
    const current = source.value
    if (!current || job.value) return
    const page = await request<FanfictionJobPage>(`${base.value}/jobs?sourceId=${current.id}&activeOnly=true&limit=1`)
    if (!valid(id) || source.value?.id !== current.id || job.value) return
    job.value = page.items[0] ?? null
    if (job.value) return
    const recent = await request<FanfictionJobPage>(`${base.value}/jobs?sourceId=${current.id}&kind=replacement&limit=1`)
    if (!valid(id) || source.value?.id !== current.id || job.value) return
    const candidate = recent.items[0]
    if (candidate && ['review_required', 'failed', 'cancelled', 'configuration_blocked'].includes(candidate.state)) job.value = candidate
  }
  async function selectSource() {
    profileId.value = source.value?.profileId ?? ''
    interval.value = source.value?.intervalMinutes === null ? 'manual' : String(source.value?.intervalMinutes ?? 1440)
    revisions.value = []
    revisionCursor.value = null
    currentRevisionId.value = null
    job.value = null
    replacementFile.value = null
    clearTimeout(timer)
    await perform(async (id) => {
      await Promise.all([loadHistory(id), recoverJob(id)])
    })
    poll(generation)
  }
  function chooseReplacement(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0] ?? null
    input.value = ''
    replacementFile.value = null
    error.value = ''
    if (file && (!file.name.toLowerCase().endsWith('.epub') || file.size === 0 || file.size > 128 * 1024 * 1024)) {
      error.value = 'Choose a non-empty EPUB no larger than 128 MiB.'
      return
    }
    replacementFile.value = file
  }
  async function uploadReplacement() {
    if (busy.value || !canReplace.value || !replacementFile.value) return
    await perform(async (id) => {
      const current = source.value!
      const file = replacementFile.value!
      const expectedRevisionId = currentRevisionId.value!
      const identity = `${current.id}:${expectedRevisionId}`
      const keys = replacementKeys.get(file) ?? new Map<string, string>()
      replacementKeys.set(file, keys)
      const idempotencyKey = keys.get(identity) ?? crypto.randomUUID()
      keys.set(identity, idempotencyKey)
      const body = new FormData()
      body.append('file', file, file.name)
      const query = new URLSearchParams({ idempotencyKey, expectedRevisionId })
      const result = await request<FanfictionJob>(`${base.value}/sources/${current.id}/replacement?${query}`, body)
      if (valid(id) && source.value?.id === current.id) {
        if (replacementFile.value === file) replacementFile.value = null
        await acceptJob(id, result)
        poll(id)
      }
    })
  }
  async function approveReplacement() {
    if (busy.value || !canApproveReplacement.value) return
    await perform(async (id) => {
      const currentJob = job.value!
      const review = currentJob.result!.replacement!
      const result = await request<FanfictionJob>(`${base.value}/jobs/${currentJob.id}/approve-replacement`, {
        sha256: review.sha256,
        expectedRevisionId: review.expectedRevisionId,
      })
      if (valid(id) && job.value?.id === currentJob.id) {
        failures = 0
        pollingBlocked = false
        await acceptJob(id, result)
        poll(id)
      }
    })
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
      if (valid(id) && source.value?.id === current.id) {
        await acceptJob(id, result)
        poll(id)
      }
    })
  }
  async function acceptJob(id: number, result: FanfictionJob) {
    if (!valid(id)) return
    job.value = result
    if (['queued', 'running'].includes(result.state)) return
    const updatedBookId = toValue(bookId)
    await refresh()
    if (valid(id) && ['succeeded', 'no_change'].includes(result.state)) await onBookUpdated?.(updatedBookId)
  }
  function poll(id: number) {
    if (!valid(id)) return
    clearTimeout(timer)
    if (
      !allowed.value ||
      pollingBlocked ||
      failures >= 5 ||
      document.hidden ||
      !navigator.onLine ||
      !job.value ||
      (polling?.generation === id && polling.jobId === job.value.id) ||
      !['queued', 'running'].includes(job.value.state)
    )
      return
    const jobId = job.value.id
    timer = setTimeout(
      () => {
        const active = { generation: id, jobId }
        polling = active
        void (async () => {
          try {
            const result = await request<FanfictionJob>(`${base.value}/jobs/${jobId}`)
            if (!valid(id) || job.value?.id !== jobId) return
            failures = 0
            error.value = ''
            await acceptJob(id, result)
          } catch (failure) {
            if (valid(id) && job.value?.id === jobId) {
              error.value = failure instanceof Error ? failure.message : 'Request failed'
              failures++
              pollingBlocked = failure instanceof StoryRequestError && [400, 401, 403, 404].includes(failure.status)
            }
          } finally {
            if (polling === active) polling = null
            if (job.value?.id === jobId) poll(id)
          }
        })()
      },
      failures ? Math.min(60_000, 3000 * 2 ** failures) : 3000,
    )
  }
  const checkNow = () => enqueue('update')
  const refreshChapters = () => enqueue('refresh')
  async function retryJob() {
    await perform(async (id) => {
      if (!job.value) return
      const jobId = job.value.id
      const result = await request<FanfictionJob>(`${base.value}/jobs/${jobId}/retry`, {})
      if (valid(id) && job.value?.id === jobId) {
        failures = 0
        pollingBlocked = false
        await acceptJob(id, result)
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
      for (const controller of inFlight) controller.abort()
      allowed.value = false
      denied.value = false
      busy.value = false
      failures = 0
      pollingBlocked = false
      requests.clear()
      sources.value = []
      sourceCursor.value = null
      sourceId.value = ''
      revisions.value = []
      revisionCursor.value = null
      currentRevisionId.value = null
      profiles.value = []
      profileCursor.value = null
      job.value = null
      replacementFile.value = null
      error.value = ''
      loading.value = true
      if (!toValue(permitted) || toValue(libraryId) === undefined) {
        loading.value = false
        return
      }
      try {
        await loadSources(id)
        if (valid(id)) await Promise.all([loadHistory(id), loadProfiles(id), recoverJob(id)])
        poll(id)
      } catch (failure) {
        if (valid(id)) error.value = failure instanceof Error ? failure.message : 'Request failed'
      } finally {
        if (valid(id)) loading.value = false
      }
    },
    { immediate: true },
  )
  function resumePolling() {
    clearTimeout(timer)
    if (document.hidden || !navigator.onLine || pollingBlocked || !visible.value) return
    failures = 0
    if (allowed.value) poll(generation)
    else if (!loading.value && !busy.value) void refresh()
  }
  document.addEventListener('visibilitychange', resumePolling)
  window.addEventListener('online', resumePolling)
  window.addEventListener('offline', resumePolling)
  onScopeDispose(() => {
    disposed = true
    generation++
    clearTimeout(timer)
    for (const controller of inFlight) controller.abort()
    document.removeEventListener('visibilitychange', resumePolling)
    window.removeEventListener('online', resumePolling)
    window.removeEventListener('offline', resumePolling)
  })
  return {
    allowed,
    visible,
    loading,
    error,
    sources,
    sourceCursor,
    sourceId,
    source,
    canUpdate,
    canReplace,
    canApproveReplacement,
    replacementFile,
    chooseReplacement,
    uploadReplacement,
    approveReplacement,
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

import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type {
  FanfictionJob,
  FanfictionJobPage,
  FanfictionSource,
  FanfictionSourceBatchAction,
  FanfictionSourceBatchFailurePage,
} from '@bookorbit/types'
import { api } from '@/lib/api'

class BatchRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export function useFanfictionSourceBatch(
  libraryId: MaybeRefOrGetter<number | null>,
  sources: MaybeRefOrGetter<FanfictionSource[]>,
  search: MaybeRefOrGetter<string>,
  state: MaybeRefOrGetter<string>,
  onCompleted: () => void | Promise<void>,
) {
  const selectedIds = ref<string[]>([])
  const allMatching = ref(false)
  const action = ref<FanfictionSourceBatchAction>('update')
  const interval = ref('1440')
  const job = ref<FanfictionJob | null>(null)
  const failures = ref<FanfictionSourceBatchFailurePage['items']>([])
  const failureCursor = ref<string | null>(null)
  const busy = ref(false)
  const error = ref('')
  const active = computed(() => !!job.value && ['queued', 'running'].includes(job.value.state))
  const canStart = computed(() => toValue(libraryId) !== null && !busy.value && !active.value && (allMatching.value || selectedIds.value.length > 0))
  const canRetry = computed(() => !!job.value && ['failed', 'cancelled', 'configuration_blocked', 'review_required'].includes(job.value.state))
  const base = computed(() => `/api/v1/libraries/${toValue(libraryId)}/fanfiction`)
  let generation = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pollFailures = 0
  let pollingBlocked = false
  let polling: number | null = null
  let completedJob: string | null = null
  let pending: { input: string; key: string } | null = null
  const controllers = new Set<AbortController>()
  const valid = (id: number) => id === generation && !disposed

  async function request<T>(url: string, body?: unknown): Promise<T> {
    const controller = new AbortController()
    controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await api(url, {
        signal: controller.signal,
        ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new BatchRequestError(typeof result.message === 'string' ? result.message : `HTTP ${response.status}`, response.status)
      return result as T
    } finally {
      clearTimeout(timeout)
      controllers.delete(controller)
    }
  }
  function failed(id: number, failure: unknown) {
    if (!valid(id)) return
    error.value = failure instanceof Error ? failure.message : 'Request failed'
    pollFailures++
    pollingBlocked = failure instanceof BatchRequestError && [400, 401, 403, 404].includes(failure.status)
  }
  async function perform(operation: (id: number) => Promise<void>) {
    if (toValue(libraryId) === null || busy.value) return
    const id = ++generation
    clearTimeout(timer)
    for (const controller of controllers) controller.abort()
    busy.value = true
    error.value = ''
    pollFailures = 0
    pollingBlocked = false
    try {
      await operation(id)
    } catch (failure) {
      failed(id, failure)
    } finally {
      if (valid(id)) {
        busy.value = false
        schedulePoll(id)
      }
    }
  }
  async function loadFailures(id: number, cursor?: string) {
    const current = job.value
    if (!current) return
    const page = await request<FanfictionSourceBatchFailurePage>(
      `${base.value}/source-batches/${current.id}/failures?limit=25${cursor ? `&cursor=${cursor}` : ''}`,
    )
    if (!valid(id) || job.value?.id !== current.id) return
    failures.value = page.items
    failureCursor.value = page.nextCursor
  }
  async function acceptJob(id: number, result: FanfictionJob) {
    if (!valid(id)) return
    job.value = result
    if (result.state === 'review_required') await loadFailures(id)
    if (!valid(id)) return
    if (['succeeded', 'review_required'].includes(result.state) && completedJob !== result.id) {
      completedJob = result.id
      await onCompleted()
    }
  }
  function schedulePoll(id: number) {
    if (!valid(id)) return
    clearTimeout(timer)
    if (!active.value || polling === id || busy.value || pollFailures >= 5 || pollingBlocked || document.hidden || !navigator.onLine) return
    const jobId = job.value!.id
    timer = setTimeout(
      () => {
        polling = id
        void (async () => {
          try {
            const result = await request<FanfictionJob>(`${base.value}/jobs/${jobId}`)
            if (!valid(id) || job.value?.id !== jobId) return
            pollFailures = 0
            error.value = ''
            await acceptJob(id, result)
          } catch (failure) {
            failed(id, failure)
          } finally {
            if (polling === id) polling = null
            schedulePoll(id)
          }
        })()
      },
      pollFailures ? Math.min(60_000, 3000 * 2 ** pollFailures) : 3000,
    )
  }
  async function refresh() {
    await perform(async (id) => {
      if (job.value) await acceptJob(id, await request<FanfictionJob>(`${base.value}/jobs/${job.value.id}`))
      else {
        const page = await request<FanfictionJobPage>(`${base.value}/jobs?kind=source_batch&limit=1`)
        if (page.items[0]) await acceptJob(id, page.items[0])
      }
    })
  }
  async function open(jobId: string) {
    await perform(async (id) => {
      const result = await request<FanfictionJob>(`${base.value}/jobs/${jobId}`)
      if (!valid(id) || result.kind !== 'source_batch') return
      failures.value = []
      failureCursor.value = null
      completedJob = null
      await acceptJob(id, result)
    })
  }
  async function start() {
    if (!canStart.value) return
    await perform(async (id) => {
      const minutes = interval.value === 'manual' ? null : Number(interval.value)
      if (action.value === 'schedule' && minutes !== null && (!Number.isInteger(minutes) || minutes < 60 || minutes > 525600))
        throw new Error('Use an interval between 60 and 525600 minutes.')
      const input = {
        action: action.value,
        ...(allMatching.value
          ? { allMatching: true, ...(toValue(search) ? { search: toValue(search) } : {}), ...(toValue(state) ? { state: toValue(state) } : {}) }
          : { ids: [...selectedIds.value].sort() }),
        ...(action.value === 'schedule' ? { intervalMinutes: minutes } : {}),
      }
      const identity = JSON.stringify(input)
      if (pending?.input !== identity) pending = { input: identity, key: crypto.randomUUID() }
      const result = await request<FanfictionJob>(`${base.value}/source-batches`, { ...input, idempotencyKey: pending.key })
      if (!valid(id)) return
      pending = null
      failures.value = []
      failureCursor.value = null
      await acceptJob(id, result)
    })
  }
  async function retry() {
    await perform(async (id) => {
      if (!job.value) return
      const result = await request<FanfictionJob>(`${base.value}/jobs/${job.value.id}/retry`, {})
      if (!valid(id)) return
      completedJob = null
      failures.value = []
      failureCursor.value = null
      await acceptJob(id, result)
    })
  }
  async function cancel() {
    await perform(async (id) => {
      if (!job.value) return
      const jobId = job.value.id
      await request(`${base.value}/jobs/${jobId}/cancel`, {})
      if (valid(id)) await acceptJob(id, await request<FanfictionJob>(`${base.value}/jobs/${jobId}`))
    })
  }
  const moreFailures = () => perform((id) => loadFailures(id, failureCursor.value ?? undefined))
  function selectPage() {
    selectedIds.value = toValue(sources)
      .map((source) => source.id)
      .slice(0, 100)
  }
  function clearSelection() {
    selectedIds.value = []
    allMatching.value = false
  }
  watch(
    () =>
      toValue(sources)
        .map((source) => source.id)
        .join(','),
    () => {
      selectedIds.value = selectedIds.value.filter((id) => toValue(sources).some((source) => source.id === id))
    },
  )
  watch(
    () => toValue(libraryId),
    () => {
      generation++
      clearTimeout(timer)
      for (const controller of controllers) controller.abort()
      pending = null
      completedJob = null
      job.value = null
      failures.value = []
      failureCursor.value = null
      busy.value = false
      error.value = ''
      clearSelection()
      if (toValue(libraryId) !== null) void refresh()
    },
    { immediate: true },
  )
  function resume() {
    clearTimeout(timer)
    if (document.hidden || !navigator.onLine || pollingBlocked) return
    pollFailures = 0
    if (!job.value && error.value) void refresh()
    else schedulePoll(generation)
  }
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('online', resume)
  window.addEventListener('offline', resume)
  onScopeDispose(() => {
    disposed = true
    generation++
    clearTimeout(timer)
    for (const controller of controllers) controller.abort()
    document.removeEventListener('visibilitychange', resume)
    window.removeEventListener('online', resume)
    window.removeEventListener('offline', resume)
  })
  return {
    selectedIds,
    allMatching,
    action,
    interval,
    job,
    failures,
    failureCursor,
    busy,
    error,
    active,
    canStart,
    canRetry,
    start,
    open,
    refresh,
    retry,
    cancel,
    moreFailures,
    selectPage,
    clearSelection,
  }
}

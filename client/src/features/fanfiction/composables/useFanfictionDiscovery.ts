import { computed, onScopeDispose, ref, watch } from 'vue'
import type {
  FanfictionCandidateState,
  FanfictionDiscoveryCandidate,
  FanfictionDiscoveryPage,
  FanfictionJob,
  FanfictionJobPage,
} from '@bookorbit/types'
import { api } from '@/lib/api'

class DiscoveryRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export function useFanfictionDiscovery(libraryId: number) {
  const base = `/api/v1/libraries/${libraryId}/fanfiction`
  const items = ref<FanfictionDiscoveryCandidate[]>([])
  const cursor = ref<string | null>(null)
  const urlPrefixesText = ref('')
  const urlPrefixes = computed(() =>
    urlPrefixesText.value
      .split(/\r?\n/)
      .map((url) => url.trim())
      .filter(Boolean),
  )
  const appliedPrefixes = ref<string[]>([])
  const filterDirty = computed(() => JSON.stringify(urlPrefixes.value) !== JSON.stringify(appliedPrefixes.value))
  const state = ref<FanfictionCandidateState>('pending')
  const selected = ref<string[]>([])
  const allMatching = ref(false)
  const choices = ref<Record<string, string>>({})
  const job = ref<FanfictionJob | null>(null)
  const busy = ref(false)
  const error = ref('')
  const pending = ref<{ path: string; body: Record<string, unknown> } | null>(null)
  const active = computed(() => job.value !== null && ['queued', 'running'].includes(job.value.state))
  const locked = computed(() => busy.value || active.value || pending.value !== null)
  const reviewable = computed(() => ['pending', 'ambiguous', 'failed'].includes(state.value))
  const canApprove = computed(
    () =>
      !filterDirty.value &&
      reviewable.value &&
      (allMatching.value || selected.value.length > 0) &&
      (state.value !== 'ambiguous' || (!allMatching.value && selected.value.length === 1 && Boolean(choices.value[selected.value[0]!]))),
  )
  watch(urlPrefixesText, () => {
    selected.value = []
    allMatching.value = false
  })
  let disposed = false
  let requestId = 0
  let pageCursor: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await api(
      path,
      body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
    const result = await response.json().catch(() => ({}))
    if (!response.ok)
      throw new DiscoveryRequestError(typeof result.message === 'string' ? result.message : `HTTP ${response.status}`, response.status)
    return result as T
  }
  async function perform(action: () => Promise<void>) {
    if (busy.value || disposed) return
    busy.value = true
    error.value = ''
    try {
      await action()
    } catch (failure) {
      if (!disposed) error.value = failure instanceof Error ? failure.message : 'Request failed'
    } finally {
      if (!disposed) busy.value = false
    }
  }
  async function load(next: string | null) {
    const current = ++requestId
    const query = new URLSearchParams({ limit: '50', state: state.value })
    if (next) query.set('cursor', next)
    if (appliedPrefixes.value.length) query.set('urlPrefixes', appliedPrefixes.value.join('\n'))
    const page = await request<FanfictionDiscoveryPage>(`${base}/discovery?${query}`)
    if (disposed || current !== requestId) return
    items.value = page.items
    cursor.value = page.nextCursor
    pageCursor = next
    selected.value = []
    allMatching.value = false
    choices.value = {}
  }
  async function refresh() {
    await perform(async () => {
      const previous = appliedPrefixes.value
      appliedPrefixes.value = [...urlPrefixes.value]
      items.value = []
      cursor.value = null
      selected.value = []
      allMatching.value = false
      try {
        await load(null)
      } catch (failure) {
        appliedPrefixes.value = previous
        throw failure
      }
    })
  }
  async function nextPage() {
    if (cursor.value) await perform(() => load(cursor.value))
  }
  async function recover() {
    await perform(async () => {
      await load(null)
      const kinds = ['discovery', 'adopt']
      const activePages = await Promise.all(kinds.map((kind) => request<FanfictionJobPage>(`${base}/jobs?limit=1&kind=${kind}&activeOnly=true`)))
      if (disposed) return
      let recovered = activePages.flatMap((page) => page.items)
      if (!recovered.length) {
        const latest = await Promise.all(kinds.map((kind) => request<FanfictionJobPage>(`${base}/jobs?limit=1&kind=${kind}`)))
        if (disposed) return
        recovered = latest.flatMap((page) => page.items)
      }
      job.value = recovered.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
      schedulePoll()
    })
  }
  function schedulePoll() {
    clearTimeout(timer)
    if (disposed || !active.value) return
    timer = setTimeout(() => {
      void poll()
    }, 3000)
  }
  async function poll() {
    if (disposed || !job.value) return
    if (busy.value) {
      schedulePoll()
      return
    }
    try {
      const updated = await request<FanfictionJob>(`${base}/jobs/${job.value.id}`)
      if (disposed) return
      job.value = updated
      error.value = ''
      if (!active.value) await load(pageCursor)
    } catch (failure) {
      if (!disposed) error.value = failure instanceof Error ? failure.message : 'Request failed'
    } finally {
      schedulePoll()
    }
  }
  async function submitPending() {
    await perform(async () => {
      const operation = pending.value
      if (!operation) return
      let result: FanfictionJob
      try {
        result = await request<FanfictionJob>(operation.path, operation.body)
      } catch (failure) {
        if (failure instanceof DiscoveryRequestError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status))
          pending.value = null
        throw failure
      }
      if (disposed) return
      job.value = result
      pending.value = null
      selected.value = []
      allMatching.value = false
      schedulePoll()
    })
  }
  async function scan() {
    if (locked.value) return
    pending.value = { path: `${base}/discovery`, body: { idempotencyKey: crypto.randomUUID() } }
    await submitPending()
  }
  async function review(decision: 'approve' | 'reject', profileId: string, schedule: string, autoProfile = false) {
    if (filterDirty.value || locked.value || !reviewable.value || (!allMatching.value && !selected.value.length)) return
    if (decision === 'approve' && !canApprove.value) return
    const canonicalUrl = !allMatching.value && selected.value.length === 1 ? choices.value[selected.value[0]!] : undefined
    pending.value = {
      path: `${base}/discovery/selection`,
      body: {
        idempotencyKey: crypto.randomUUID(),
        decision,
        state: state.value,
        ...(appliedPrefixes.value.length ? { urlPrefixes: [...appliedPrefixes.value] } : {}),
        ...(allMatching.value ? { allMatching: true } : { ids: [...selected.value] }),
        ...(decision === 'approve'
          ? {
              profileId: profileId || null,
              ...(autoProfile && !profileId ? { autoProfile: true } : {}),
              intervalMinutes: schedule === 'manual' ? null : Number(schedule),
              ...(canonicalUrl ? { canonicalUrl } : {}),
            }
          : {}),
      },
    }
    await submitPending()
  }
  async function cancel() {
    await perform(async () => {
      if (!job.value || !active.value) return
      job.value = await request<FanfictionJob>(`${base}/jobs/${job.value.id}/cancel`, {})
      schedulePoll()
    })
  }
  async function retry() {
    await perform(async () => {
      if (!job.value || active.value) return
      job.value = await request<FanfictionJob>(`${base}/jobs/${job.value.id}/retry`, {})
      schedulePoll()
    })
  }
  function selectPage() {
    allMatching.value = false
    selected.value = items.value.map((item) => item.id)
  }
  onScopeDispose(() => {
    disposed = true
    requestId++
    clearTimeout(timer)
  })
  return {
    items,
    urlPrefixesText,
    filterDirty,
    cursor,
    state,
    selected,
    allMatching,
    choices,
    job,
    busy,
    error,
    pending,
    active,
    locked,
    reviewable,
    canApprove,
    refresh,
    nextPage,
    recover,
    scan,
    review,
    cancel,
    retry,
    submitPending,
    selectPage,
  }
}

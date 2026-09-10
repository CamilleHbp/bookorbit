import { computed, onScopeDispose, ref } from 'vue'
import type {
  FanfictionDiscoveryComparison,
  FanfictionDiscoveryWebsites,
  FanfictionDiscoveryWebsite,
  FanfictionJob,
  FanfictionJobPage,
} from '@bookorbit/types'
import { api } from '@/lib/api'

class ReviewRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}
export function useDiscoveryReview(libraryId: number) {
  const base = `/api/v1/libraries/${libraryId}/fanfiction`
  const websites = ref<FanfictionDiscoveryWebsite[]>([])
  const cutoff = ref('')
  const cursor = ref<string | null>(null)
  const busy = ref(false)
  const error = ref('')
  const job = ref<FanfictionJob | null>(null)
  const pending = ref<Record<string, unknown> | null>(null)
  const active = computed(() => Boolean(job.value && ['queued', 'running'].includes(job.value.state)))
  const locked = computed(() => busy.value || active.value || Boolean(pending.value))
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pendingPath = ''
  let remoteActive = 0
  const remoteWaiters: (() => void)[] = []
  async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await api(`${base}${path}`, {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal,
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new ReviewRequestError(typeof result.message === 'string' ? result.message : `HTTP ${response.status}`, response.status)
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
  async function loadWebsites(next = false, newScan = false) {
    const query = new URLSearchParams({ limit: '50' })
    if (cutoff.value && !newScan) query.set('cutoff', cutoff.value)
    if (next && cursor.value !== null) query.set('cursor', cursor.value)
    const page = await request<FanfictionDiscoveryWebsites>(`/discovery/websites?${query}`)
    if (disposed) return
    cutoff.value = page.cutoff
    if (next) websites.value = [...websites.value, ...page.items]
    else if (newScan || !websites.value.length) websites.value = page.items
    else {
      // Refresh counts without removing or reordering website panels already being reviewed.
      const updated = new Map(page.items.map((item) => [item.website, item]))
      websites.value = websites.value.map((item) => updated.get(item.website) ?? item)
    }
    cursor.value = page.nextCursor
  }
  async function updateWebsite(website: string) {
    const query = new URLSearchParams({ limit: '1', website, cutoff: cutoff.value })
    const page = await request<FanfictionDiscoveryWebsites>(`/discovery/websites?${query}`)
    if (disposed || !page.items.length) return
    const updated = page.items[0]!
    if (websites.value.some((item) => item.website === website))
      websites.value = websites.value.map((item) => (item.website === website ? updated : item))
    else websites.value = [...websites.value, updated]
  }
  async function moreWebsites() {
    await perform(() => loadWebsites(true))
  }
  function schedulePoll() {
    clearTimeout(timer)
    if (!disposed && active.value)
      timer = setTimeout(() => {
        void poll()
      }, 2000)
  }
  async function poll() {
    if (disposed || !job.value) return
    if (busy.value) {
      schedulePoll()
      return
    }
    try {
      const updated = await request<FanfictionJob>(`/jobs/${job.value.id}`)
      if (disposed) return
      job.value = updated
      error.value = ''
      if (!active.value) {
        if (updated.kind === 'discovery') await loadWebsites(false, true)
        else if (updated.reviewWebsite !== undefined) await updateWebsite(updated.reviewWebsite)
      }
    } catch (failure) {
      if (!disposed) error.value = failure instanceof Error ? failure.message : 'Request failed'
    } finally {
      schedulePoll()
    }
  }
  async function recover() {
    await perform(async () => {
      await loadWebsites()
      const pages = await Promise.all(['discovery', 'adopt'].map((kind) => request<FanfictionJobPage>(`/jobs?limit=1&kind=${kind}&activeOnly=true`)))
      if (disposed) return
      job.value = pages.flatMap((page) => page.items).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
      if (job.value?.reviewWebsite !== undefined) await updateWebsite(job.value.reviewWebsite)
      schedulePoll()
    })
  }
  async function submitPending() {
    await perform(async () => {
      if (!pending.value) return
      try {
        const result = await request<FanfictionJob>(pendingPath, pending.value)
        if (disposed) return
        job.value = result
        pending.value = null
        schedulePoll()
      } catch (failure) {
        if (failure instanceof ReviewRequestError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status))
          pending.value = null
        throw failure
      }
    })
  }
  async function submit(body: Record<string, unknown>) {
    if (locked.value) return
    pendingPath = '/discovery/selection'
    pending.value = { ...body, idempotencyKey: crypto.randomUUID() }
    await submitPending()
  }
  async function scan() {
    if (locked.value) return
    pendingPath = '/discovery'
    pending.value = { idempotencyKey: crypto.randomUUID() }
    await submitPending()
  }
  async function cancel() {
    await perform(async () => {
      if (job.value && active.value) job.value = await request<FanfictionJob>(`/jobs/${job.value.id}/cancel`, {})
      schedulePoll()
    })
  }
  async function retry(jobId = job.value?.id) {
    await perform(async () => {
      if (jobId && !active.value) job.value = await request<FanfictionJob>(`/jobs/${jobId}/retry`, {})
      schedulePoll()
    })
  }
  async function compare(id: string, body: Record<string, unknown>, signal: AbortSignal) {
    if (remoteActive >= 2) await new Promise<void>((resolve) => remoteWaiters.push(resolve))
    else remoteActive++
    try {
      if (disposed || signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      return await request<FanfictionDiscoveryComparison>(`/discovery/${id}/compare`, body, signal)
    } finally {
      const next = remoteWaiters.shift()
      if (next) next()
      else remoteActive--
    }
  }
  onScopeDispose(() => {
    disposed = true
    clearTimeout(timer)
  })
  return {
    websites,
    cutoff,
    cursor,
    busy,
    error,
    job,
    pending,
    active,
    locked,
    request,
    recover,
    moreWebsites,
    scan,
    submit,
    submitPending,
    cancel,
    retry,
    compare,
  }
}
export type DiscoveryReview = ReturnType<typeof useDiscoveryReview>

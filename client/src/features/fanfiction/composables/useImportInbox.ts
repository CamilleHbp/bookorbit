import { onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { FanfictionJob, FanfictionJobPage } from '@bookorbit/types'
import { api } from '@/lib/api'

export function useImportInbox(libraryId: MaybeRefOrGetter<number>) {
  const jobs = ref<FanfictionJob[]>([])
  const busy = ref(false)
  const error = ref(false)
  const actionId = ref<string | null>(null)
  const nextCursor = ref<string | null>(null)
  const page = ref(1)
  let cursors: (string | null)[] = [null]
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let actionController: AbortController | undefined

  function poll() {
    clearTimeout(timer)
    if (jobs.value.some((job) => ['queued', 'running'].includes(job.state))) timer = setTimeout(() => void load(page.value), 5000)
  }
  async function load(target = page.value) {
    controller?.abort()
    clearTimeout(timer)
    const request = new AbortController()
    controller = request
    const current = generation
    busy.value = true
    error.value = false
    const timeout = setTimeout(() => request.abort(), 20000)
    try {
      const query = new URLSearchParams({ pendingImportsOnly: 'true', limit: '20' })
      const cursor = cursors[target - 1]
      if (cursor) query.set('cursor', cursor)
      const response = await api(`/api/v1/libraries/${toValue(libraryId)}/fanfiction/jobs?${query}`, { signal: request.signal })
      if (!response.ok) throw new Error()
      const result = (await response.json()) as FanfictionJobPage
      if (current !== generation || controller !== request || request.signal.aborted) return
      jobs.value = result.items
      nextCursor.value = result.nextCursor
      page.value = target
      poll()
    } catch {
      if (current === generation && controller === request) error.value = true
    } finally {
      clearTimeout(timeout)
      if (controller === request) busy.value = false
    }
  }
  async function next() {
    if (!nextCursor.value || busy.value) return
    cursors[page.value] = nextCursor.value
    await load(page.value + 1)
  }
  async function previous() {
    if (page.value > 1 && !busy.value) await load(page.value - 1)
  }
  async function act(job: FanfictionJob, action: 'retry' | 'cancel') {
    if (actionId.value) return
    const current = generation
    const request = new AbortController()
    actionController = request
    const timeout = setTimeout(() => request.abort(), 20000)
    actionId.value = job.id
    error.value = false
    try {
      const response = await api(`/api/v1/libraries/${toValue(libraryId)}/fanfiction/jobs/${job.id}/${action}`, {
        signal: request.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (!response.ok) throw new Error()
      const result = (await response.json()) as FanfictionJob
      if (current === generation) updated(result)
    } catch {
      if (current === generation) error.value = true
    } finally {
      clearTimeout(timeout)
      if (current === generation) actionId.value = null
    }
  }
  function updated(job: FanfictionJob) {
    controller?.abort()
    controller = undefined
    busy.value = false
    jobs.value = jobs.value
      .map((item) => (item.id === job.id ? job : item))
      .filter((item) => !['cancelled', 'succeeded', 'no_change'].includes(item.state))
    poll()
  }
  watch(
    () => toValue(libraryId),
    () => {
      generation++
      actionController?.abort()
      jobs.value = []
      page.value = 1
      cursors = [null]
      nextCursor.value = null
      actionId.value = null
      void load(1)
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    generation++
    controller?.abort()
    actionController?.abort()
    clearTimeout(timer)
  })
  return {
    jobs,
    busy,
    error,
    actionId,
    nextCursor,
    page,
    next,
    previous,
    retry: (job: FanfictionJob) => act(job, 'retry'),
    cancel: (job: FanfictionJob) => act(job, 'cancel'),
    updated,
    reload: () => load(),
  }
}

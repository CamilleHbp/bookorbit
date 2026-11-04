import { computed, onScopeDispose, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TagMatchingApplyJob, TagMatchingJobPage } from '@bookorbit/types'
import { api } from '@/lib/api'

export function useTagMatchingJobs() {
  const { t } = useI18n()
  const job = ref<TagMatchingApplyJob | null>(null)
  const items = ref<TagMatchingJobPage['items']>([])
  const total = ref(0),
    page = ref(1),
    busy = ref(false),
    error = ref('')
  const overrideTags = ref(false),
    overrideGenres = ref(false)
  const previewOverrides = ref<string[]>([])
  const overrides = computed(() => [...(overrideTags.value ? ['tags' as const] : []), ...(overrideGenres.value ? ['genres' as const] : [])])
  const dirty = computed(() => [...overrides.value].sort().join() !== [...previewOverrides.value].sort().join())
  const pages = computed(() => Math.max(1, Math.ceil(total.value / 20)))
  const canApply = computed(() => job.value?.state === 'ready' && !dirty.value && !busy.value && !error.value && total.value > 0)
  const controllers = new Set<AbortController>()
  let disposed = false
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController()
    controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 60000)
    try {
      const response = await api(`/api/v1/tag-matching/${path}`, {
        signal: controller.signal,
        ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
      if (!response.ok) throw new Error(t(response.status === 409 ? 'tagMatching.preview.stale' : 'tagMatching.requestError'))
      return (await response.json()) as T
    } finally {
      clearTimeout(timeout)
      controllers.delete(controller)
    }
  }
  async function loadItems() {
    if (!job.value) return
    const data = await request<TagMatchingJobPage>(`jobs/${job.value.id}?page=${page.value}&pageSize=20`)
    if (disposed) return
    job.value = data.job
    items.value = data.items
    total.value = data.total
  }
  async function work() {
    while (!disposed && job.value && ['previewing', 'running', 'failed'].includes(job.value.state)) {
      job.value = await request<TagMatchingApplyJob>(`jobs/${job.value.id}/advance`, {})
      if (job.value.state === 'failed') break
    }
    if (!disposed) await loadItems()
  }
  async function perform(action: () => Promise<void>) {
    if (busy.value) return
    busy.value = true
    error.value = ''
    try {
      await action()
    } catch (cause) {
      if (!disposed) {
        error.value = (cause as Error).message
        try {
          await loadItems()
        } catch {
          /* Keep the original failure visible. */
        }
      }
    } finally {
      busy.value = false
    }
  }
  async function initialize() {
    await perform(async () => {
      job.value = await request<TagMatchingApplyJob | null>('jobs/latest')
      if (!job.value) return
      await loadItems()
      previewOverrides.value = items.value[0]?.overrideFields ?? []
      overrideTags.value = previewOverrides.value.includes('tags')
      overrideGenres.value = previewOverrides.value.includes('genres')
      if (['previewing', 'running'].includes(job.value.state)) await work()
    })
  }
  async function preview() {
    await perform(async () => {
      job.value = await request<TagMatchingApplyJob>('previews', { overrideFields: overrides.value })
      previewOverrides.value = [...overrides.value]
      page.value = 1
      await loadItems()
      await work()
    })
  }
  async function apply() {
    if (!canApply.value || !job.value) return
    await perform(async () => {
      job.value = await request<TagMatchingApplyJob>(`jobs/${job.value!.id}/apply`, {})
      await work()
    })
  }
  async function resume() {
    if (!job.value) {
      await initialize()
      return
    }
    await perform(work)
  }
  async function previous() {
    if (page.value > 1) {
      page.value--
      await perform(loadItems)
    }
  }
  async function next() {
    if (page.value < pages.value) {
      page.value++
      await perform(loadItems)
    }
  }
  onScopeDispose(() => {
    disposed = true
    controllers.forEach((controller) => controller.abort())
  })
  return {
    job,
    items,
    total,
    page,
    pages,
    busy,
    error,
    overrideTags,
    overrideGenres,
    dirty,
    canApply,
    initialize,
    preview,
    apply,
    resume,
    previous,
    next,
  }
}

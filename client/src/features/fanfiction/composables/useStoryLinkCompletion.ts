import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { FanfictionJob } from '@bookorbit/types'
import { api } from '@/lib/api'

export function useStoryLinkCompletion(libraryId: () => number, job: Ref<FanfictionJob | null>, linked: () => void) {
  const active = computed(() => !!job.value && ['queued', 'running'].includes(job.value.state))
  const failed = computed(() => !!job.value && !active.value && (job.value.state !== 'succeeded' || !!job.value.result?.selection?.failed))
  const statusUnavailable = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let generation = 0
  let notified: string | undefined

  function stop() {
    generation++
    clearTimeout(timer)
    controller?.abort()
  }
  function schedule() {
    clearTimeout(timer)
    if (active.value) timer = setTimeout(() => void refresh(), 3000)
  }
  async function refresh() {
    if (!job.value) return
    stop()
    const current = generation
    controller = new AbortController()
    try {
      const response = await api(`/api/v1/libraries/${libraryId()}/fanfiction/jobs/${job.value.id}`, { signal: controller.signal })
      if (!response.ok) throw new Error('Could not load linking status')
      const updated: FanfictionJob = await response.json()
      if (current !== generation) return
      statusUnavailable.value = false
      job.value = updated
    } catch {
      if (current === generation) statusUnavailable.value = true
    } finally {
      if (current === generation) schedule()
    }
  }
  watch(
    [libraryId, job],
    () => {
      stop()
      statusUnavailable.value = false
      if (job.value?.state === 'succeeded' && !job.value.result?.selection?.failed && notified !== job.value.id) {
        notified = job.value.id
        linked()
      }
      schedule()
    },
    { immediate: true },
  )
  onScopeDispose(stop)
  return { active, failed, statusUnavailable, refresh }
}

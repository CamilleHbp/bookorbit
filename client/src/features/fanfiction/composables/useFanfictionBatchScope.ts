import { onScopeDispose, ref, watch, type Ref } from 'vue'
import type { FanfictionSourceBatchScope } from '@bookorbit/types'
import { api } from '@/lib/api'

export function useFanfictionBatchScope(libraryId: Ref<number | null>, search: Ref<string>, state: Ref<string>) {
  const counts = ref<FanfictionSourceBatchScope | null>(null)
  const error = ref(false)
  let controller: AbortController | undefined
  async function reload() {
    controller?.abort()
    counts.value = null
    error.value = false
    if (libraryId.value === null) return
    const current = new AbortController()
    controller = current
    const timeout = setTimeout(() => current.abort(), 20_000)
    const query = new URLSearchParams({ search: search.value, ...(state.value ? { state: state.value } : {}) })
    try {
      const response = await api(`/api/v1/libraries/${libraryId.value}/fanfiction/source-batches/scope?${query}`, { signal: current.signal })
      if (!response.ok) throw new Error('Story count unavailable')
      const result = (await response.json()) as FanfictionSourceBatchScope
      if (controller === current && !current.signal.aborted) counts.value = result
    } catch {
      if (controller === current) error.value = true
    } finally {
      clearTimeout(timeout)
    }
  }
  watch([libraryId, search, state], reload, { immediate: true })
  onScopeDispose(() => {
    controller?.abort()
    controller = undefined
  })
  return { counts, error, reload }
}

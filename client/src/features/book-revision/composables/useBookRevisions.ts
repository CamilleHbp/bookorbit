import { onUnmounted, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { BookFileRevisionPage, BookFileRevisionSummary } from '@bookorbit/types'
import { api } from '@/lib/api'

export function useBookRevisions(libraryId: MaybeRefOrGetter<number>, fileId: MaybeRefOrGetter<number>) {
  const expanded = ref(false)
  const loading = ref(false)
  const failed = ref(false)
  const items = ref<BookFileRevisionSummary[]>([])
  const nextCursor = ref<string | null>(null)
  const currentCursor = ref<string | null>(null)
  let request: AbortController | null = null
  let requestedCursor: string | null = null

  async function load(cursor: string | null = null) {
    request?.abort()
    const controller = new AbortController()
    request = controller
    requestedCursor = cursor
    loading.value = true
    failed.value = false
    try {
      const query = new URLSearchParams({ limit: '25' })
      if (cursor) query.set('cursor', cursor)
      const response = await api(`/api/v1/libraries/${toValue(libraryId)}/files/${toValue(fileId)}/revisions?${query}`, { signal: controller.signal })
      if (!response.ok) throw new Error('Revision history request failed')
      const page: BookFileRevisionPage = await response.json()
      if (request !== controller) return
      items.value = page.items
      nextCursor.value = page.nextCursor
      currentCursor.value = cursor
    } catch {
      if (request === controller && !controller.signal.aborted) failed.value = true
    } finally {
      if (request === controller) loading.value = false
    }
  }

  function toggle() {
    expanded.value = !expanded.value
    if (expanded.value) void load()
  }

  function older() {
    if (nextCursor.value && !loading.value) void load(nextCursor.value)
  }

  function newest() {
    void load()
  }
  function retry() {
    void load(requestedCursor)
  }

  watch(
    () => [toValue(libraryId), toValue(fileId)],
    () => {
      request?.abort()
      request = null
      items.value = []
      nextCursor.value = null
      currentCursor.value = null
      requestedCursor = null
      loading.value = false
      failed.value = false
      if (expanded.value) void load()
    },
  )
  onUnmounted(() => request?.abort())

  return { expanded, loading, failed, items, nextCursor, currentCursor, toggle, older, newest, retry }
}

import { computed, onScopeDispose, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TagMatchingBookPreview } from '@bookorbit/types'
import { api } from '@/lib/api'
export function useTagMatchingBookDetails(jobId: string, bookId: number) {
  const { t } = useI18n()
  const open = ref(false),
    busy = ref(false),
    error = ref(''),
    page = ref(1)
  const data = ref<TagMatchingBookPreview | null>(null)
  const pages = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / 25)))
  const hasProtectedChanges = computed(() => data.value && Object.values(data.value.protectedChanges).some((values) => values.length))
  let controller: AbortController | undefined
  async function load() {
    if (busy.value) return
    busy.value = true
    error.value = ''
    controller = new AbortController()
    const timeout = setTimeout(() => controller?.abort(), 30000)
    try {
      const response = await api(`/api/v1/tag-matching/jobs/${jobId}/books/${bookId}?page=${page.value}&pageSize=25`, { signal: controller.signal })
      if (!response.ok) throw new Error(t(response.status === 409 ? 'tagMatching.preview.stale' : 'tagMatching.requestError'))
      data.value = await response.json()
    } catch (cause) {
      error.value = (cause as Error).message
      data.value = null
    } finally {
      clearTimeout(timeout)
      busy.value = false
    }
  }
  async function toggle() {
    open.value = !open.value
    if (open.value && !data.value) await load()
  }
  async function previous() {
    if (!busy.value && page.value > 1) {
      page.value--
      await load()
    }
  }
  async function next() {
    if (!busy.value && page.value < pages.value) {
      page.value++
      await load()
    }
  }
  onScopeDispose(() => controller?.abort())
  return { open, busy, error, page, data, pages, hasProtectedChanges, load, toggle, previous, next }
}

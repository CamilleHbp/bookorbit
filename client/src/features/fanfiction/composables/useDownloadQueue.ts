import { onMounted, onScopeDispose, ref } from 'vue'
import type { FanfictionDownloadQueue, FanfictionDownloadSection } from '@bookorbit/types'
import { api } from '@/lib/api'

export const sections = ['running', 'queued', 'retrying', 'attention'] as const
export function useDownloadQueue(libraryId: number, group?: { section: FanfictionDownloadSection; key: string }) {
  const snapshot = ref<FanfictionDownloadQueue>()
  const offsets = ref<Record<FanfictionDownloadSection, number>>({ running: 0, queued: 0, retrying: 0, attention: 0 })
  const lastSeen = ref<Date>()
  const error = ref(false)
  const busy = ref(false)
  let timer: ReturnType<typeof setTimeout>
  let active: AbortController | undefined
  let disposed = false
  async function reload(section?: FanfictionDownloadSection, delta = 0) {
    clearTimeout(timer)
    active?.abort()
    const controller = new AbortController()
    active = controller
    busy.value = true
    const requested = { ...offsets.value }
    if (section) requested[section] = Math.max(0, requested[section] + delta)
    const timeout = setTimeout(() => controller.abort(), 20000)
    const get = async (params: URLSearchParams) => {
      const res = await api(`/api/v1/libraries/${libraryId}/fanfiction/downloads?${params}`, { signal: controller.signal })
      if (!res.ok) throw new Error()
      return (await res.json()) as FanfictionDownloadQueue
    }
    try {
      const base = await get(new URLSearchParams(group ? { section: group.section, group: group.key, offset: String(requested[group.section]) } : {}))
      if (!group) {
        await Promise.all(
          sections
            .filter((key) => requested[key] && base.totals[key] > 0)
            .map(async (key) => {
              const page = await get(new URLSearchParams({ section: key, offset: String(requested[key]) }))
              base.items = [...base.items.filter((row) => row.section !== key), ...page.items]
              base.totals[key] = page.totals[key]
            }),
        )
      }
      if (disposed || active !== controller || controller.signal.aborted) return
      for (const key of sections) requested[key] = Math.min(requested[key], Math.floor(Math.max(0, base.totals[key] - 1) / 20) * 20)
      snapshot.value = base
      offsets.value = requested
      lastSeen.value = new Date()
      error.value = false
    } catch {
      if (!disposed && active === controller) error.value = true
    } finally {
      clearTimeout(timeout)
      if (!disposed && active === controller) {
        busy.value = false
        if (!document.hidden) timer = setTimeout(refresh, snapshot.value?.totals.running || snapshot.value?.totals.queued ? 5000 : 20000)
      }
    }
  }
  function refresh() {
    void reload()
  }
  function visibility() {
    if (document.hidden) clearTimeout(timer)
    else refresh()
  }
  onMounted(() => {
    refresh()
    document.addEventListener('visibilitychange', visibility)
  })
  onScopeDispose(() => {
    disposed = true
    clearTimeout(timer)
    active?.abort()
    document.removeEventListener('visibilitychange', visibility)
  })
  return { snapshot, offsets, lastSeen, busy, error, reload, refresh }
}

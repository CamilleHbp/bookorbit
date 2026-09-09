import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { useFanfiction } from './useFanfiction'

const tabs = ['stories', 'add', 'discovery', 'activity', 'profiles'] as const
type Tab = (typeof tabs)[number]

export function useFanfictionNavigation(page: ReturnType<typeof useFanfiction>) {
  const route = useRoute()
  const router = useRouter()
  const filtered = computed(() => Boolean(page.search.value || page.state.value))
  let pendingFilters = false

  watch(
    () => [route.query.tab, route.query.search, route.query.state],
    () => {
      const tab = typeof route.query.tab === 'string' && tabs.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'stories'
      const search = typeof route.query.search === 'string' ? route.query.search.slice(0, 200) : ''
      const state =
        typeof route.query.state === 'string' && ['active', 'paused', 'review_required', 'configuration_blocked'].includes(route.query.state)
          ? route.query.state
          : ''
      pendingFilters ||= page.libraryId.value !== null && (page.search.value !== search || page.state.value !== state)
      page.tab.value = tab
      page.search.value = search
      page.state.value = state
      flushFilters()
    },
    { immediate: true },
  )
  watch(page.busy, flushFilters)

  function flushFilters() {
    if (!pendingFilters || page.busy.value || page.libraryId.value === null) return
    pendingFilters = false
    void page.applyFilters()
  }
  function destination(tab: Tab) {
    return { name: 'fanfiction', query: { ...route.query, tab } }
  }
  function selectTab(tab: Tab) {
    void router.push(destination(tab))
  }
  function showStories() {
    selectTab('stories')
  }
  function showAdd() {
    selectTab('add')
  }
  async function applyFilters() {
    await router.replace({
      name: 'fanfiction',
      query: { ...route.query, tab: page.tab.value, search: page.search.value || undefined, state: page.state.value || undefined },
    })
    await page.applyFilters()
  }
  async function clearFilters() {
    page.search.value = ''
    page.state.value = ''
    await applyFilters()
  }
  return { destination, showStories, showAdd, applyFilters, clearFilters, filtered }
}

import { computed, onActivated, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { BrowseEntityItem, GroupRule, SortSpec } from '@bookorbit/types'
import { browseTags } from '../api/tags'
import { useBookWindow } from '@/features/book/composables/useBookWindow'
import { useViewSearch } from '@/features/book/composables/useViewSearch'

export function useTagBrowser() {
  const route = useRoute()
  const router = useRouter()
  const selected = computed(() => {
    const value = route.query.tag
    return [
      ...new Set(
        (Array.isArray(value) ? value : [value]).filter((tag): tag is string => typeof tag === 'string' && tag.length > 0 && tag.length <= 200),
      ),
    ].slice(0, 50)
  })
  const match = computed(() => (route.query.match === 'any' ? 'any' : 'all'))
  function toggleTag(name: string) {
    const next = selected.value.includes(name) ? selected.value.filter((tag) => tag !== name) : [...selected.value, name].slice(0, 50)
    void router.push({ query: { ...route.query, tag: next.length ? next : undefined } })
  }
  function clearTags() {
    void router.push({ query: { ...route.query, tag: undefined } })
  }
  function setMatch(event: Event) {
    const value = (event.target as HTMLSelectElement).value
    void router.push({ query: { ...route.query, match: value === 'any' ? 'any' : undefined } })
  }
  const tagSearch = ref('')
  const prefix = ref<string>()
  const separator = ref<string>()
  const page = ref(1)
  const tags = ref<BrowseEntityItem[]>([])
  const tagTotal = ref(0)
  const tagsLoading = ref(false)
  const tagsError = ref(false)
  const totalPages = computed(() => Math.max(1, Math.ceil(tagTotal.value / 30)))
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  async function loadTags() {
    const request = ++generation
    tagsLoading.value = true
    tagsError.value = false
    try {
      const result = await browseTags({
        search: tagSearch.value || undefined,
        tagSeparator: separator.value,
        tagPrefix: prefix.value,
        page: page.value,
        pageSize: 30,
      })
      if (request !== generation) return
      tags.value = result.items
      tagTotal.value = result.total
      if (page.value > totalPages.value) page.value = totalPages.value
    } catch {
      if (request === generation) tagsError.value = true
    } finally {
      if (request === generation) tagsLoading.value = false
    }
  }
  function setGroup(nextSeparator?: string, nextPrefix?: string) {
    separator.value = nextSeparator
    prefix.value = nextPrefix
    page.value = 1
  }
  function clearGroup() {
    prefix.value = undefined
    page.value = 1
  }
  function previousPage() {
    page.value = Math.max(1, page.value - 1)
  }
  function nextPage() {
    page.value = Math.min(totalPages.value, page.value + 1)
  }
  watch([separator, prefix, page], loadTags, { immediate: true })
  watch(tagSearch, () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (page.value === 1) void loadTags()
      else page.value = 1
    }, 250)
  })
  let activated = false
  onActivated(() => {
    if (activated) void loadTags()
    activated = true
  })
  onUnmounted(() => {
    generation++
    clearTimeout(timer)
  })

  const { searchQuery, debouncedQuery } = useViewSearch()
  const sortKey = ref('title')
  const filter = computed<GroupRule | undefined>(() =>
    selected.value.length
      ? {
          type: 'group',
          join: 'AND',
          rules: [{ type: 'rule', field: 'tag', operator: match.value === 'any' ? 'includesAny' : 'includesAll', value: selected.value }],
        }
      : undefined,
  )
  const query = computed(() => ({
    filter: filter.value,
    q: debouncedQuery.value || undefined,
    sort: [{ field: sortKey.value, dir: sortKey.value === 'title' ? 'asc' : 'desc' }] as SortSpec[],
  }))
  const books = useBookWindow({ endpoint: ref('/api/v1/books/query'), query })
  function loadMore() {
    return books.ensureRange(books.contiguousPrefix.value.length, books.contiguousPrefix.value.length + 99)
  }
  return {
    selected,
    match,
    toggleTag,
    clearTags,
    setMatch,
    tagSearch,
    tags,
    tagTotal,
    tagsLoading,
    tagsError,
    prefix,
    separator,
    page,
    totalPages,
    loadTags,
    setGroup,
    clearGroup,
    previousPage,
    nextPage,
    searchQuery,
    sortKey,
    books,
    loadMore,
  }
}

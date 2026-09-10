import { computed, onScopeDispose, ref, watch } from 'vue'
import type {
  FanfictionDiscoveryCandidate,
  FanfictionDiscoveryComparison,
  FanfictionDiscoveryPage,
  FanfictionDiscoveryWebsite,
  FanfictionJob,
} from '@bookorbit/types'
import type { DiscoveryReview } from './useDiscoveryReview'
import { discoverySources } from './discoveryReview'

export function comparisonMatches(book: FanfictionDiscoveryCandidate, remote: FanfictionDiscoveryComparison) {
  const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
  return (
    Boolean(normalize(book.title)) &&
    normalize(book.title) === normalize(remote.title) &&
    book.authors.length > 0 &&
    book.authors.every((author) => remote.authors.some((remoteAuthor) => normalize(author) === normalize(remoteAuthor)))
  )
}
type Comparison = { state: 'loading' | 'ready' | 'failed'; remote?: FanfictionDiscoveryComparison; error?: string }
export function useWebsiteReview(source: () => FanfictionDiscoveryWebsite, cutoff: () => string, review: DiscoveryReview) {
  const open = ref(false)
  const items = ref<FanfictionDiscoveryCandidate[]>([])
  const total = ref(source().remaining)
  const cursor = ref<string | null>(null)
  const history = ref<(string | null)[]>([])
  const loading = ref(false)
  const error = ref('')
  const selectionError = ref('')
  const profile = ref('auto')
  const schedule = ref('manual')
  const sourceChoices = ref<Record<string, string>>({})
  const profileChoices = ref<Record<string, string>>({})
  const comparisons = ref<Record<string, Comparison>>({})
  const selected = ref<string[]>([])
  const excluded = ref<string[]>([])
  const all = ref(false)
  const finished = ref(false)
  const touched = new Set<string>()
  const compared = ref(new Set<string>())
  let autoSelect = true
  let loaded = false
  let pageCursor: string | null = null
  let disposed = false
  let epoch = 0
  let controllers: AbortController[] = []
  const busy = computed(() => loading.value || review.locked.value)
  const selectedCount = computed(() => (all.value ? Math.max(0, total.value - excluded.value.length) : selected.value.length))
  const pageNumber = computed(() => history.value.length + 1)
  const comparing = computed(() => Object.values(comparisons.value).some((value) => value.state === 'loading'))
  const uncheckedCount = computed(() =>
    all.value
      ? Math.max(0, selectedCount.value - [...compared.value].filter((id) => !excluded.value.includes(id)).length)
      : selected.value.filter((id) => !compared.value.has(id)).length,
  )
  const targetJob = ref<FanfictionJob | null>(review.job.value?.reviewWebsite === source().website ? review.job.value : null)
  watch(review.job, (job) => {
    if (job?.reviewWebsite === source().website) targetJob.value = job
  })
  const reviewable = (book: FanfictionDiscoveryCandidate) => ['pending', 'ambiguous', 'failed'].includes(book.state)
  function isSelected(book: FanfictionDiscoveryCandidate) {
    return reviewable(book) && (all.value ? !excluded.value.includes(book.id) : selected.value.includes(book.id))
  }
  function urlFor(book: FanfictionDiscoveryCandidate) {
    return sourceChoices.value[book.id] || (discoverySources(book).length === 1 ? discoverySources(book)[0] : '')
  }
  function profileFor(book: FanfictionDiscoveryCandidate) {
    return profileChoices.value[book.id] ?? profile.value
  }
  function stopComparisons() {
    epoch++
    controllers.forEach((controller) => controller.abort())
    controllers = []
  }
  async function compareBook(book: FanfictionDiscoveryCandidate) {
    const url = urlFor(book)
    if (!url || !open.value || !reviewable(book)) return
    const current = epoch
    const controller = new AbortController()
    controllers.push(controller)
    const choice = profileFor(book)
    comparisons.value[book.id] = { state: 'loading' }
    try {
      const remote = await review.compare(
        book.id,
        { canonicalUrl: url, autoProfile: choice === 'auto', profileId: ['auto', 'public'].includes(choice) ? null : choice },
        controller.signal,
      )
      if (disposed || current !== epoch || controller.signal.aborted) return
      comparisons.value[book.id] = { state: 'ready', remote }
      compared.value.add(book.id)
      if (autoSelect && !all.value && !touched.has(book.id) && selected.value.length < 100 && comparisonMatches(book, remote))
        selected.value = [...new Set([...selected.value, book.id])]
    } catch (failure) {
      if (!disposed && current === epoch && !controller.signal.aborted)
        comparisons.value[book.id] = { state: 'failed', error: failure instanceof Error ? failure.message : 'Remote details unavailable' }
    } finally {
      controllers = controllers.filter((value) => value !== controller)
    }
  }
  function comparePage() {
    items.value.forEach((book) => {
      if (comparisons.value[book.id]?.state !== 'ready') void compareBook(book)
    })
  }
  async function load(next: string | null) {
    if (loading.value) return
    loading.value = true
    error.value = ''
    const query = new URLSearchParams({ website: source().website, cutoff: cutoff(), review: 'true', limit: '20' })
    if (next) query.set('cursor', next)
    try {
      const page = await review.request<FanfictionDiscoveryPage>(`/discovery?${query}`)
      if (disposed) return
      stopComparisons()
      comparisons.value = {}
      items.value = page.items
      total.value = page.total ?? source().remaining
      cursor.value = page.nextCursor
      pageCursor = next
      loaded = true
      finished.value = false
      comparePage()
    } catch (failure) {
      if (!disposed) error.value = failure instanceof Error ? failure.message : 'Request failed'
    } finally {
      if (!disposed) loading.value = false
    }
  }
  async function toggleOpen() {
    open.value = !open.value
    if (open.value) {
      if (!loaded) await load(null)
      else comparePage()
    } else stopComparisons()
  }
  async function nextPage() {
    if (busy.value || cursor.value === null) return
    const previous = pageCursor
    await load(cursor.value)
    if (!error.value) history.value.push(previous)
  }
  async function previousPage() {
    if (busy.value || !history.value.length) return
    await load(history.value.at(-1) ?? null)
    if (!error.value) history.value.pop()
  }
  function toggleAll() {
    if (busy.value) return
    autoSelect = false
    if (all.value || selectedCount.value === total.value) {
      all.value = false
      selected.value = []
      excluded.value = []
    } else {
      all.value = true
      selected.value = []
      excluded.value = []
    }
  }
  function toggleBook(book: FanfictionDiscoveryCandidate) {
    if (busy.value || !reviewable(book)) return
    touched.add(book.id)
    if (all.value) {
      if (excluded.value.includes(book.id)) excluded.value = excluded.value.filter((id) => id !== book.id)
      else if (excluded.value.length < 1000) excluded.value = [...excluded.value, book.id]
      else selectionError.value = 'exclusionLimit'
    } else if (selected.value.includes(book.id)) selected.value = selected.value.filter((id) => id !== book.id)
    else if (selected.value.length < 100) selected.value = [...selected.value, book.id]
  }
  function clearSelection() {
    selectionError.value = ''
    autoSelect = false
    all.value = false
    selected.value = []
    excluded.value = []
  }
  async function changeProfile() {
    stopComparisons()
    comparisons.value = {}
    clearSelection()
    touched.clear()
    autoSelect = true
    profileChoices.value = {}
    compared.value.clear()
    comparePage()
  }
  function changeBook(book: FanfictionDiscoveryCandidate) {
    // A new URL/account invalidates the previous comparison before it can select the book.
    stopComparisons()
    selected.value = selected.value.filter((id) => id !== book.id)
    touched.delete(book.id)
    compared.value.delete(book.id)
    delete comparisons.value[book.id]
    comparePage()
  }
  async function link() {
    if (busy.value || !selectedCount.value) return
    const ids = new Set(selected.value)
    const overrides = [...new Set([...Object.keys(profileChoices.value), ...Object.keys(sourceChoices.value)])]
      .filter((id) => (all.value ? !excluded.value.includes(id) : ids.has(id)))
      .map((id) => ({
        id,
        ...(profileChoices.value[id] && profileChoices.value[id] !== 'auto'
          ? { profileId: profileChoices.value[id] === 'public' ? null : profileChoices.value[id] }
          : {}),
        ...(sourceChoices.value[id] ? { canonicalUrl: sourceChoices.value[id] } : {}),
      }))
    if (overrides.length > 100) {
      selectionError.value = 'overrideLimit'
      return
    }
    await review.submit({
      decision: 'approve',
      review: true,
      website: source().website,
      cutoff: cutoff(),
      autoProfile: profile.value === 'auto',
      profileId: ['auto', 'public'].includes(profile.value) ? null : profile.value,
      intervalMinutes: schedule.value === 'manual' ? null : Number(schedule.value),
      ...(all.value ? { allMatching: true, excludedIds: [...excluded.value] } : { ids: [...selected.value] }),
      ...(overrides.length ? { overrides } : {}),
    })
  }
  async function updateOutcomes() {
    clearSelection()
    stopComparisons()
    finished.value = true
    if (!items.value.length) return
    const query = new URLSearchParams({ ids: items.value.map((book) => book.id).join(','), website: source().website, limit: '100' })
    try {
      const page = await review.request<FanfictionDiscoveryPage>(`/discovery?${query}`)
      if (disposed) return
      const byId = new Map(page.items.map((book) => [book.id, book]))
      items.value = items.value.map((book) => byId.get(book.id) ?? book)
      total.value = source().remaining
    } catch (failure) {
      if (!disposed) error.value = failure instanceof Error ? failure.message : 'Could not load linking results'
    }
  }
  async function remaining() {
    if (busy.value) return
    clearSelection()
    touched.clear()
    autoSelect = true
    history.value = []
    await load(null)
  }
  watch(
    () => targetJob.value?.state,
    (state, previous) => {
      if (state && previous && !['queued', 'running'].includes(state) && ['queued', 'running'].includes(previous)) void updateOutcomes()
    },
  )
  watch(
    () => source().remaining,
    (count) => {
      total.value = count
    },
  )
  onScopeDispose(() => {
    disposed = true
    stopComparisons()
  })
  return {
    open,
    items,
    total,
    cursor,
    pageNumber,
    loading,
    error,
    selectionError,
    profile,
    schedule,
    sourceChoices,
    profileChoices,
    comparisons,
    selectedCount,
    all,
    busy,
    finished,
    comparing,
    uncheckedCount,
    targetJob,
    reviewable,
    isSelected,
    urlFor,
    profileFor,
    toggleOpen,
    nextPage,
    previousPage,
    toggleAll,
    toggleBook,
    clearSelection,
    changeProfile,
    changeBook,
    compareBook,
    link,
    remaining,
  }
}

import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  BookDetail,
  FanfictionMetadataChoices,
  FanfictionMetadataReviewView,
  FanfictionMetadataValues,
  FanfictionReviewScope,
  FanfictionSource,
  FanfictionSourcePage,
} from '@bookorbit/types'
import { isFanfictionWebsiteAccessProblem } from '@bookorbit/types'
import { canReviewStory } from './storyReview'
import { api } from '@/lib/api'
import { readApiErrorDetail } from '@/lib/api-error'

interface Entry {
  source: FanfictionSource
  review: FanfictionMetadataReviewView | null
  values: FanfictionMetadataValues
  choices: FanfictionMetadataChoices
  lockedFields: string[]
  baseline: string
  loaded: boolean
  saved: boolean
  skipped: boolean
}

const emptyValues = (): FanfictionMetadataValues => ({ title: '', description: '', authors: [], genres: [], tags: [] })
const emptyChoices = (): FanfictionMetadataChoices => ({ title: 'keep', authors: 'keep', description: 'keep', genres: 'keep', tags: 'keep' })
const snapshot = (entry: Entry) => JSON.stringify(entry.review ? entry.choices : entry.values)
const dirty = (entry: Entry) => entry.loaded && !entry.saved && snapshot(entry) !== entry.baseline

export type StoryReviewScope = FanfictionReviewScope

export function useStoryReviewQueue(
  libraryId: Ref<number>,
  scope: Ref<StoryReviewScope>,
  target?: { sourceId: Ref<string | undefined>; bookId: Ref<number | undefined> },
) {
  const { t } = useI18n()
  const entries = ref<Entry[]>([])
  const index = ref(0)
  const offset = ref(0)
  const total = ref(0)
  const cursor = ref<string | null>(null)
  const started = ref(false)
  const busy = ref(false)
  const error = ref('')
  const savedCount = ref(0)
  const skippedCount = ref(0)
  const current = computed(() => entries.value[index.value])
  const finished = computed(() => started.value && !busy.value && !error.value && !current.value && !cursor.value)
  const hasDrafts = computed(() => entries.value.some(dirty))
  const position = computed(() => offset.value + index.value + 1)
  const hasPrevious = computed(() => index.value > 0)
  let controller: AbortController | undefined
  let generation = 0
  let pinnedId: string | undefined
  let targetLoaded = false

  function confirmLeave() {
    return !hasDrafts.value || window.confirm(t('fanfiction.reviewQueue.discardDrafts'))
  }

  async function request<T>(path: string, signal: AbortSignal, body?: unknown, method = 'POST'): Promise<T> {
    const response = await api(path, {
      signal,
      ...(body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error((await readApiErrorDetail(response)) ?? t('fanfiction.reviewQueue.requestFailed'))
    return response.json() as Promise<T>
  }

  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (busy.value) return
    const version = generation
    const active = new AbortController()
    controller = active
    const timeout = setTimeout(() => active.abort(), 30000)
    busy.value = true
    error.value = ''
    try {
      await operation(active.signal)
    } catch (failure) {
      if (version === generation)
        error.value = active.signal.aborted
          ? t('fanfiction.reviewQueue.requestFailed')
          : failure instanceof Error
            ? failure.message
            : t('fanfiction.reviewQueue.requestFailed')
    } finally {
      clearTimeout(timeout)
      if (version === generation) busy.value = false
    }
  }

  function createEntry(source: FanfictionSource): Entry {
    return {
      source,
      review: null,
      values: emptyValues(),
      choices: emptyChoices(),
      lockedFields: [],
      baseline: '',
      loaded: false,
      saved: false,
      skipped: false,
    }
  }

  async function loadTarget(signal: AbortSignal) {
    if (targetLoaded || scope.value !== 'attention') return
    targetLoaded = true
    let source: FanfictionSource | undefined
    if (target?.sourceId.value) {
      source = await request<FanfictionSource>(`/api/v1/libraries/${libraryId.value}/fanfiction/sources/${target.sourceId.value}`, signal)
    } else if (target?.bookId.value) {
      const page = await request<FanfictionSourcePage>(
        `/api/v1/libraries/${libraryId.value}/fanfiction/sources?reviewScope=attention&bookId=${target.bookId.value}&limit=1`,
        signal,
      )
      source = page.items[0]
    }
    if (signal.aborted || !source || !canReviewStory(source)) return
    pinnedId = source.id
    entries.value.push(createEntry(source))
  }

  async function loadPage(signal: AbortSignal) {
    while (!signal.aborted) {
      const query = new URLSearchParams({ reviewScope: scope.value, limit: '25', ...(cursor.value ? { cursor: cursor.value } : {}) })
      const page = await request<FanfictionSourcePage>(`/api/v1/libraries/${libraryId.value}/fanfiction/sources?${query}`, signal)
      if (signal.aborted) return
      const previousLength = entries.value.length
      entries.value.push(
        ...page.items.filter((source) => source.id !== pinnedId && !isFanfictionWebsiteAccessProblem(source.attentionCode)).map(createEntry),
      )
      total.value = Math.max(total.value, page.total ?? 0, offset.value + entries.value.length)
      cursor.value = page.nextCursor
      started.value = true
      if (entries.value.length > previousLength || !cursor.value) return
    }
  }

  async function loadEntry(entry: Entry, signal: AbortSignal) {
    if (entry.loaded) return
    if (scope.value === 'attention') {
      entry.loaded = true
      entry.baseline = snapshot(entry)
      return
    }
    const review = await request<FanfictionMetadataReviewView | null>(
      `/api/v1/libraries/${libraryId.value}/fanfiction/sources/${entry.source.id}/metadata-review`,
      signal,
    )
    if (signal.aborted) return
    if (review) {
      entry.review = review
      entry.choices = structuredClone(
        review.review.choices ?? {
          ...emptyChoices(),
          tags: 'keep',
        },
      )
      entry.choices.values ??= structuredClone(review.review.current)
      entry.lockedFields = review.review.lockedFields
    } else {
      const book = await request<BookDetail>(`/api/v1/books/${entry.source.bookId}`, signal)
      if (signal.aborted) return
      entry.values = {
        title: book.title ?? '',
        description: book.description ?? '',
        authors: book.authors.map((author) => author.name),
        genres: book.genres,
        tags: book.tags,
      }
      entry.lockedFields = book.lockedFields
    }
    entry.loaded = true
    entry.baseline = snapshot(entry)
  }

  async function advance(signal: AbortSignal) {
    if (index.value === entries.value.length - 1 && cursor.value) await loadPage(signal)
    if (signal.aborted) return
    index.value++
    if (current.value) await loadEntry(current.value, signal)
  }

  function canAdvance() {
    // Keep at most two pages of visited editors, including large description drafts.
    if (index.value < 49) return true
    const oldest = entries.value.slice(0, 25)
    if (oldest.some(dirty) && !window.confirm(t('fanfiction.reviewQueue.discardOlderDrafts'))) return false
    entries.value.splice(0, 25)
    index.value -= 25
    offset.value += 25
    return true
  }

  async function next() {
    if (busy.value || !current.value || !canAdvance()) return
    await run(async (signal) => {
      const entry = current.value!
      if (!entry.saved && !entry.skipped) {
        entry.skipped = true
        skippedCount.value++
      }
      await advance(signal)
    })
  }

  async function completeAttention(resolved: boolean) {
    if (busy.value || !current.value || !canAdvance()) return
    await run(async (signal) => {
      const entry = current.value!
      if (!entry.saved && resolved) {
        entry.saved = true
        savedCount.value++
        if (entry.skipped) skippedCount.value--
        entry.skipped = false
      } else if (!entry.saved && !entry.skipped) {
        entry.skipped = true
        skippedCount.value++
      }
      await advance(signal)
    })
  }

  async function excludeCurrent() {
    if (busy.value || !current.value) return
    await run(async (signal) => {
      entries.value.splice(index.value, 1)
      total.value = Math.max(0, total.value - 1)
      if (!current.value && cursor.value) await loadPage(signal)
      if (current.value) await loadEntry(current.value, signal)
    })
  }

  async function previous() {
    if (busy.value || !hasPrevious.value) return
    await run(async (signal) => {
      index.value--
      await loadEntry(current.value!, signal)
    })
  }

  async function save() {
    if (busy.value || !current.value?.loaded || !canAdvance()) return
    await run(async (signal) => {
      const entry = current.value!
      if (!entry.saved) {
        if (entry.review) {
          await request(`/api/v1/libraries/${libraryId.value}/fanfiction/sources/${entry.source.id}/metadata-review`, signal, {
            ...entry.choices,
            jobId: entry.review.jobId,
            fingerprint: entry.review.review.fingerprint,
          })
        } else {
          const original = JSON.parse(entry.baseline) as FanfictionMetadataValues
          const changes = Object.fromEntries(
            Object.entries(entry.values).filter(
              ([field, value]) => JSON.stringify(value) !== JSON.stringify(original[field as keyof FanfictionMetadataValues]),
            ),
          )
          if (Object.keys(changes).length)
            await request(
              `/api/v1/books/${entry.source.bookId}/metadata-and-locks`,
              signal,
              { metadata: changes, lockedFields: entry.lockedFields },
              'PATCH',
            )
        }
        if (signal.aborted) return
        entry.saved = true
        savedCount.value++
        if (entry.skipped) {
          entry.skipped = false
          skippedCount.value--
        }
      }
      await advance(signal)
    })
  }

  async function retry() {
    await run(async (signal) => {
      if (!started.value) {
        await loadTarget(signal)
        await loadPage(signal)
      } else if (!current.value && cursor.value) await loadPage(signal)
      if (current.value) await loadEntry(current.value, signal)
    })
  }

  async function reloadCurrent() {
    if (busy.value || !current.value) return
    if (dirty(current.value) && !window.confirm(t('fanfiction.reviewQueue.discardCurrentDraft'))) return
    current.value.loaded = false
    current.value.review = null
    await retry()
  }

  function restart() {
    if (!confirmLeave()) return
    reset()
  }

  function reset() {
    generation++
    controller?.abort()
    entries.value = []
    targetLoaded = false
    pinnedId = undefined
    index.value = offset.value = total.value = savedCount.value = skippedCount.value = 0
    cursor.value = null
    started.value = busy.value = false
    error.value = ''
    void retry()
  }
  watch([libraryId, scope, () => target?.sourceId.value, () => target?.bookId.value], reset, { immediate: true })
  onScopeDispose(() => {
    generation++
    controller?.abort()
  })

  return {
    current,
    busy,
    error,
    finished,
    hasDrafts,
    position,
    total,
    hasPrevious,
    savedCount,
    skippedCount,
    next,
    completeAttention,
    excludeCurrent,
    previous,
    save,
    retry,
    restart,
    reloadCurrent,
    confirmLeave,
  }
}

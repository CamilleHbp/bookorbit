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

export function useStoryReviewQueue(libraryId: Ref<number>, scope: Ref<FanfictionReviewScope>) {
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

  async function loadPage(signal: AbortSignal) {
    const query = new URLSearchParams({ reviewScope: scope.value, limit: '25', ...(cursor.value ? { cursor: cursor.value } : {}) })
    const page = await request<FanfictionSourcePage>(`/api/v1/libraries/${libraryId.value}/fanfiction/sources?${query}`, signal)
    if (signal.aborted) return
    entries.value.push(
      ...page.items.map((source): Entry => ({
        source,
        review: null,
        values: emptyValues(),
        choices: emptyChoices(),
        lockedFields: [],
        baseline: '',
        loaded: false,
        saved: false,
        skipped: false,
      })),
    )
    total.value = Math.max(total.value, page.total ?? 0, offset.value + entries.value.length)
    cursor.value = page.nextCursor
    started.value = true
  }

  async function loadEntry(entry: Entry, signal: AbortSignal) {
    if (entry.loaded) return
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
      if (!started.value) await loadPage(signal)
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
    index.value = offset.value = total.value = savedCount.value = skippedCount.value = 0
    cursor.value = null
    started.value = busy.value = false
    error.value = ''
    void retry()
  }
  watch([libraryId, scope], reset, { immediate: true })
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
    previous,
    save,
    retry,
    restart,
    reloadCurrent,
    confirmLeave,
  }
}

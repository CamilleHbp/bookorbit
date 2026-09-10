import { computed, onScopeDispose, ref } from 'vue'
import type {
  FanfictionExistingStory,
  FanfictionFolderPage,
  FanfictionJob,
  FanfictionJobPage,
  FanfictionLibraryPage,
  FanfictionPreview,
  FanfictionProfileMatch,
  FanfictionProfilePage,
  FanfictionProfileSummary,
  FanfictionSource,
  FanfictionSourcePage,
  FanfictionActivity,
  FanfictionActivityPage,
  FanfictionMetadataReviewConflict,
} from '@bookorbit/types'
import { api } from '@/lib/api'
import { useFanfictionPagination } from './useFanfictionPagination'

interface Candidate {
  existingStory?: FanfictionExistingStory
  updateKey?: string
  url: string
  profileId: string
  destination?: { folderId: number; intervalMinutes: number | null; collectionId?: number }
  resolvedProfileId?: string
  previewKey: string
  importKey: string
  selected: boolean
  job: FanfictionJob | null
  preview: FanfictionPreview | null
}

class ExistingStoryError extends Error {
  constructor(readonly story: FanfictionExistingStory) {
    super('This story is already in your library')
  }
}

class MetadataReviewRequiredError extends Error {
  constructor(readonly review: FanfictionMetadataReviewConflict['errorMeta']) {
    super('Review and save the story metadata before updating again.')
  }
}

export function useFanfiction(
  onMetadataReview?: (bookId: number) => Promise<unknown>,
  reviewSource?: () => string | undefined,
  initialLibraryId?: number,
) {
  const libraries = ref<FanfictionLibraryPage['items']>([])
  const libraryCursor = ref<number | null>(null)
  const libraryId = ref<number | null>(initialLibraryId ?? null)
  const folders = ref<FanfictionFolderPage['items']>([])
  const folderCursor = ref<number | null>(null)
  const collectionId = ref<number | null>(null)
  const folderId = ref<number | null>(null)
  const profiles = ref<FanfictionProfilePage['items']>([])
  const profileCursor = ref<string | null>(null)
  const profileId = ref('')
  const sources = ref<FanfictionSource[]>([])
  const sourceCursor = ref<string | null>(null)
  const jobs = ref<FanfictionJob[]>([])
  const jobCursor = ref<string | null>(null)
  const activity = ref<FanfictionActivity[]>([])
  const activityCursor = ref<string | null>(null)
  const candidates = ref<Candidate[]>([])
  const importBatchTotal = ref(0)
  const importBatchStarted = computed(() => importBatchTotal.value > 0)
  const importBatchActive = computed(() => candidates.value.some((candidate) => candidate.job && ['queued', 'running'].includes(candidate.job.state)))
  const importBatchPending = computed(() =>
    candidates.value.some(
      (candidate) =>
        (!candidate.job ||
          (candidate.job.result?.importReview && !candidate.job.result.importReview.approved && candidate.job.state !== 'cancelled')) &&
        !candidate.existingStory,
    ),
  )
  const importBatchFinished = computed(
    () => importBatchStarted.value && !busy.value && !importBatchActive.value && !importBatchPending.value && !existingStoryCount.value,
  )
  const importBatchCompleted = computed(
    () =>
      importBatchTotal.value -
      candidates.value.filter(
        (candidate) => candidate.existingStory || !candidate.job || ['queued', 'running', 'review_required'].includes(candidate.job.state),
      ).length,
  )
  const importBatchNeedsAttention = computed(() =>
    candidates.value.some((candidate) => candidate.job && ['failed', 'configuration_blocked', 'review_required'].includes(candidate.job.state)),
  )
  const existingStoryIndex = ref(0)
  const existingCandidates = computed(() => candidates.value.filter((candidate) => candidate.existingStory))
  const existingStoryPosition = computed(() => Math.min(existingStoryIndex.value, Math.max(0, existingCandidates.value.length - 1)))
  const existingCandidate = computed(() => existingCandidates.value[existingStoryPosition.value])
  const existingStoryCount = computed(() => existingCandidates.value.length)
  const hasPreviousExistingStory = computed(() => existingStoryPosition.value > 0)
  const hasNextExistingStory = computed(() => existingStoryPosition.value + 1 < existingStoryCount.value)
  const visibleCandidates = computed(() => candidates.value.filter((candidate) => !candidate.existingStory))
  const urls = ref('')
  const search = ref('')
  const state = ref('')
  const schedule = ref('1440')
  const busy = ref(false)
  const error = ref('')
  const tab = ref<'stories' | 'add' | 'discovery' | 'activity' | 'profiles'>('stories')
  const base = computed(() => `/api/v1/libraries/${libraryId.value}/fanfiction`)
  const canImport = computed(
    () =>
      folderId.value !== null &&
      candidates.value.some(
        (row) => row.profileId === profileId.value && row.selected && row.preview && row.job?.kind === 'preview' && row.job.state === 'succeeded',
      ),
  )
  let generation = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const appliedSearch = ref('')
  const filters = ref({ publication: '', sort: 'added', tag: '', genre: '', fandom: '', view: '' })
  const appliedFilters = ref({ ...filters.value })
  const appliedState = ref('')
  let sourcePage: string | null = null
  let jobPage: string | null = null
  let sourceRequest = 0
  let jobRequest = 0
  let activityRequest = 0
  let activityPage: string | null = null
  const pendingChecks = new Map<string, string>()
  const sourceJobs = ref<Record<string, FanfictionJob>>({})
  const sourceErrors = ref<Record<string, string>>({})
  const checkingSourceId = ref<string | null>(null)
  const sourcePagination = useFanfictionPagination()
  const jobPagination = useFanfictionPagination()
  const activityPagination = useFanfictionPagination()

  async function request<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
    const response = await api(
      path,
      body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
    const result = await response.json().catch(() => ({}))
    if (response.status === 409 && result.errorCode === 'metadata_review_required' && Number.isInteger(result.errorMeta?.bookId))
      throw new MetadataReviewRequiredError(result.errorMeta)
    if (
      response.status === 409 &&
      result.errorCode === 'story_exists' &&
      typeof result.errorMeta?.id === 'string' &&
      typeof result.errorMeta?.title === 'string'
    )
      throw new ExistingStoryError(result.errorMeta)
    if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : `HTTP ${response.status}`)
    return result as T
  }
  async function perform(operation: (current: number, path: string) => Promise<unknown>) {
    const current = generation
    busy.value = true
    error.value = ''
    try {
      await operation(current, base.value)
    } catch (failure) {
      if (currentScope(current) && failure instanceof MetadataReviewRequiredError && onMetadataReview) {
        await onMetadataReview(failure.review.bookId)
        return
      }
      if (current === generation && !disposed) error.value = failure instanceof Error ? failure.message : 'Request failed'
    } finally {
      if (current === generation && !disposed) busy.value = false
    }
  }
  const currentScope = (current: number) => !disposed && current === generation
  function sourceQuery(cursor: string | null) {
    const query = new URLSearchParams({ limit: '50' })
    if (cursor) query.set('cursor', cursor)
    if (appliedSearch.value) query.set('search', appliedSearch.value)
    if (appliedState.value) query.set('state', appliedState.value)
    for (const [key, value] of Object.entries(appliedFilters.value)) if (value && !(key === 'sort' && value === 'added')) query.set(key, value)
    return query.toString()
  }
  async function loadSources(current: number, path: string, cursor: string | null) {
    const requestId = ++sourceRequest
    const page = await request<FanfictionSourcePage>(`${path}/sources?${sourceQuery(cursor)}`)
    if (!currentScope(current) || requestId !== sourceRequest) return
    sources.value = page.items
    sourceCursor.value = page.nextCursor
    sourcePage = cursor
    const visible = new Set(page.items.map((source) => source.id))
    sourceJobs.value = Object.fromEntries(Object.entries(sourceJobs.value).filter(([id]) => visible.has(id)))
    sourceErrors.value = Object.fromEntries(Object.entries(sourceErrors.value).filter(([id]) => visible.has(id)))
    return true
  }
  async function loadJobs(current: number, path: string, cursor: string | null) {
    const requestId = ++jobRequest
    const page = await request<FanfictionJobPage>(
      `${path}/jobs?limit=50${reviewSource?.() ? `&sourceId=${encodeURIComponent(reviewSource()!)}` : ''}${cursor ? `&cursor=${cursor}` : ''}`,
    )
    if (!currentScope(current) || requestId !== jobRequest) return
    jobs.value = page.items
    jobCursor.value = page.nextCursor
    jobPage = cursor
    return true
  }
  async function loadActivity(current: number, path: string, cursor: string | null) {
    const requestId = ++activityRequest
    const page = await request<FanfictionActivityPage>(`${path}/activity?limit=50${cursor ? `&cursor=${cursor}` : ''}`)
    if (!currentScope(current) || requestId !== activityRequest) return
    activity.value = page.items
    activityCursor.value = page.nextCursor
    activityPage = cursor
    return true
  }
  async function navigatePage(kind: 'sources' | 'jobs' | 'activity', direction: 'next' | 'previous') {
    if (busy.value || libraryId.value === null) return
    const pagination = kind === 'sources' ? sourcePagination : kind === 'jobs' ? jobPagination : activityPagination
    const next = kind === 'sources' ? sourceCursor.value : kind === 'jobs' ? jobCursor.value : activityCursor.value
    if (direction === 'next' ? !next : !pagination.canPrevious.value) return
    const before = kind === 'sources' ? sourcePage : kind === 'jobs' ? jobPage : activityPage
    const cursor = direction === 'next' ? next : pagination.previous()
    const load = kind === 'sources' ? loadSources : kind === 'jobs' ? loadJobs : loadActivity
    await perform(async (current, path) => {
      if (!(await load(current, path, cursor))) return
      if (direction === 'next') pagination.advance(before)
      else pagination.retreat()
    })
  }
  const moreActivity = () => navigatePage('activity', 'next')
  const previousActivity = () => navigatePage('activity', 'previous')
  async function loadLibraries() {
    if (busy.value) return
    let selected = libraries.value.length === 0 && libraryId.value !== null
    await perform(async (current) => {
      const page = await request<FanfictionLibraryPage>(
        `/api/v1/fanfiction/libraries?limit=50${libraryCursor.value ? `&cursor=${libraryCursor.value}` : ''}`,
      )
      if (!currentScope(current)) return
      const pinned = libraries.value.find((library) => library.id === libraryId.value)
      libraries.value = pinned && !page.items.some((library) => library.id === pinned.id) ? [pinned, ...page.items] : page.items
      libraryCursor.value = page.nextCursor
      if (libraryId.value === null) {
        libraryId.value = page.items[0]?.id ?? null
        selected = libraryId.value !== null
      }
    })
    if (selected) await changeLibrary()
  }
  async function changeLibrary() {
    generation++
    clearTimeout(timer)
    appliedSearch.value = search.value
    appliedState.value = state.value
    appliedFilters.value = { ...filters.value }
    candidates.value = []
    importBatchTotal.value = 0
    existingStoryIndex.value = 0
    sourceJobs.value = {}
    sourceErrors.value = {}
    checkingSourceId.value = null
    pendingChecks.clear()
    sourcePagination.reset()
    jobPagination.reset()
    activityPagination.reset()
    sourceCursor.value = jobCursor.value = null
    sources.value = []
    jobs.value = []
    activity.value = []
    activityCursor.value = null
    activityPage = null
    profiles.value = []
    folders.value = []
    profileId.value = ''
    folderId.value = null
    sourcePage = jobPage = null
    if (libraryId.value === null) return
    await perform(async (current, path) => {
      const [folderPage, profilePage] = await Promise.all([
        request<FanfictionFolderPage>(`${path}/sources/folders?limit=50`),
        request<FanfictionProfilePage>(`${path}/profiles?limit=50`),
        loadSources(current, path, null),
        loadJobs(current, path, null),
        loadActivity(current, path, null),
      ])
      if (!currentScope(current)) return
      folders.value = folderPage.items
      folderCursor.value = folderPage.nextCursor
      folderId.value = folderPage.items[0]?.id ?? null
      profiles.value = profilePage.items
      profileCursor.value = profilePage.nextCursor
    })
    schedulePoll(generation)
  }
  async function moreFolders() {
    await perform(async (current, path) => {
      if (folderCursor.value === null) return
      const page = await request<FanfictionFolderPage>(`${path}/sources/folders?limit=50&cursor=${folderCursor.value}`)
      if (!currentScope(current)) return
      folders.value = page.items
      folderCursor.value = page.nextCursor
      folderId.value = page.items[0]?.id ?? null
    })
  }
  async function moreProfiles() {
    await perform(async (current, path) => {
      if (!profileCursor.value) return
      const page = await request<FanfictionProfilePage>(`${path}/profiles?limit=50&cursor=${profileCursor.value}`)
      if (!currentScope(current)) return
      profiles.value = page.items
      profileCursor.value = page.nextCursor
      profileId.value = ''
    })
  }
  async function refresh() {
    if (busy.value || libraryId.value === null) return
    await perform(async (current, path) => {
      await Promise.all([loadSources(current, path, sourcePage), loadJobs(current, path, jobPage), loadActivity(current, path, activityPage)])
    })
  }
  async function applyFilters() {
    if (busy.value || libraryId.value === null) return
    const previous = { search: appliedSearch.value, state: appliedState.value, filters: appliedFilters.value }
    appliedSearch.value = search.value
    appliedState.value = state.value
    appliedFilters.value = { ...filters.value }
    await perform(async (current, path) => {
      try {
        if (await loadSources(current, path, null)) sourcePagination.reset()
      } catch (failure) {
        if (currentScope(current)) {
          appliedSearch.value = previous.search
          appliedState.value = previous.state
          appliedFilters.value = previous.filters
        }
        throw failure
      }
    })
  }
  const moreSources = () => navigatePage('sources', 'next')
  const previousSources = () => navigatePage('sources', 'previous')
  const moreJobs = () => navigatePage('jobs', 'next')
  const previousJobs = () => navigatePage('jobs', 'previous')
  function useSavedProfile(profile: FanfictionProfileSummary) {
    if (profile.libraryId !== libraryId.value) return
    profiles.value = [profile, ...profiles.value.filter((item) => item.id !== profile.id)].slice(0, 50)
    profileId.value = profile.id
    candidates.value = candidates.value.filter((row) => row.job?.kind === 'import')
  }
  async function submitImport(candidate: Candidate, current: number, path: string) {
    if (folderId.value === null) return
    candidate.destination ??= {
      ...(collectionId.value ? { collectionId: collectionId.value } : {}),
      folderId: folderId.value,
      intervalMinutes: schedule.value === 'manual' ? null : Number(schedule.value),
    }
    if (candidate.resolvedProfileId === undefined) {
      if (candidate.profileId) candidate.resolvedProfileId = candidate.profileId
      else {
        const match = await request<FanfictionProfileMatch>(`${path}/profile-match?${new URLSearchParams({ url: candidate.url })}`)
        if (!currentScope(current)) return
        candidate.resolvedProfileId = match.profile?.id ?? ''
        if (match.profile) profiles.value = [match.profile, ...profiles.value.filter((item) => item.id !== match.profile!.id)].slice(0, 50)
      }
    }
    if (!currentScope(current)) return
    let job: FanfictionJob
    try {
      job = await request<FanfictionJob>(`${path}/sources`, {
        url: candidate.url,
        ...candidate.destination,
        idempotencyKey: candidate.importKey,
        ...(candidate.resolvedProfileId ? { profileId: candidate.resolvedProfileId } : {}),
      })
    } catch (failure) {
      if (failure instanceof ExistingStoryError) {
        if (currentScope(current)) {
          candidate.existingStory = failure.story
          await continueExisting(candidate, current, path)
        }
        return
      }
      throw failure
    }
    if (!currentScope(current)) return
    if (job.result?.existingImportId) job = await request<FanfictionJob>(`${path}/jobs/${job.result.existingImportId}`)
    candidate.job = job
    candidate.existingStory = job.result?.existingStory
    if (candidate.existingStory) await continueExisting(candidate, current, path)
    candidate.selected = false
    schedulePoll(current)
  }
  function startAnotherImportBatch() {
    if (!importBatchFinished.value) return
    candidates.value = []
    importBatchTotal.value = 0
    existingStoryIndex.value = 0
    urls.value = ''
    error.value = ''
  }

  async function importStories() {
    if (busy.value || folderId.value === null) return
    await perform(async (current, path) => {
      const lines = [
        ...new Set(
          urls.value
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ]
      if (!lines.length || lines.length > 100) throw new Error('Enter between 1 and 100 story URLs, one per line.')
      if (
        lines.some((value) => {
          try {
            const url = new URL(value)
            return value.length > 4096 || url.protocol !== 'https:' || !!url.username || !!url.password || (!!url.port && url.port !== '443')
          } catch {
            return true
          }
        })
      )
        throw new Error('Each story needs a valid HTTPS URL.')
      if (!importBatchStarted.value) {
        const prior = new Map(candidates.value.map((row) => [row.url, row]))
        candidates.value = lines.map(
          (url) =>
            prior.get(url) ?? {
              url,
              profileId: profileId.value,
              previewKey: crypto.randomUUID(),
              importKey: crypto.randomUUID(),
              selected: true,
              job: null,
              preview: null,
            },
        )
        importBatchTotal.value = candidates.value.length
      }
      for (const candidate of candidates.value) {
        if (!currentScope(current)) break
        if (candidate.job || candidate.existingStory) continue
        await submitImport(candidate, current, path)
      }
    })
  }
  function cancelExistingStory() {
    if (busy.value) return
    error.value = ''
    const candidate = existingCandidate.value
    candidates.value = candidates.value.filter((item) => item !== candidate)
    existingStoryIndex.value = existingStoryPosition.value
  }
  function previousExistingStory() {
    if (!busy.value && hasPreviousExistingStory.value) {
      error.value = ''
      existingStoryIndex.value = existingStoryPosition.value - 1
    }
  }
  function nextExistingStory() {
    if (!busy.value && hasNextExistingStory.value) {
      error.value = ''
      existingStoryIndex.value = existingStoryPosition.value + 1
    }
  }
  async function continueExisting(candidate: Candidate, current: number, path: string) {
    const story = candidate.existingStory
    if (!story || !currentScope(current)) return
    if (story.attentionCode === 'metadata_review_required' && story.bookId) {
      if (candidates.value.length === 1 && onMetadataReview) await onMetadataReview(story.bookId)
      return
    }
    candidate.updateKey ??= crypto.randomUUID()
    try {
      const job = await request<FanfictionJob>(`${path}/sources/${story.id}/check`, { kind: 'update', idempotencyKey: candidate.updateKey })
      if (!currentScope(current)) return
      candidate.job = job
      candidate.existingStory = undefined
      sourceJobs.value[story.id] = job
      schedulePoll(current)
    } catch (failure) {
      if (failure instanceof MetadataReviewRequiredError && currentScope(current)) {
        candidate.existingStory = { ...story, bookId: failure.review.bookId, attentionCode: 'metadata_review_required' }
        if (candidates.value.length === 1 && onMetadataReview) await onMetadataReview(failure.review.bookId)
        return
      }
      throw failure
    }
  }
  async function updateExistingStory() {
    const candidate = existingCandidate.value
    if (busy.value || !candidate?.existingStory) return
    if (candidate.existingStory.attentionCode === 'metadata_review_required' && candidate.existingStory.bookId && onMetadataReview) {
      await onMetadataReview(candidate.existingStory.bookId)
      return
    }
    await perform((current, path) => continueExisting(candidate, current, path))
  }
  function acceptImportReview(job: FanfictionJob) {
    jobs.value = jobs.value.map((existing) => (existing.id === job.id ? job : existing))
    for (const candidate of candidates.value) if (candidate.job?.id === job.id) candidate.job = job
    schedulePoll(generation)
  }
  async function retryImport(candidate: Candidate, profile?: FanfictionProfileSummary) {
    if (busy.value || !candidate.job || !['configuration_blocked', 'failed', 'cancelled'].includes(candidate.job.state)) return
    if (candidate.job.kind !== 'import') {
      const jobId = candidate.job.id
      await perform(async (current, path) => {
        const job = await request<FanfictionJob>(`${path}/jobs/${jobId}/retry`, {})
        if (!currentScope(current)) return
        candidate.job = job
        schedulePoll(current)
      })
      return
    }
    candidate.importKey = crypto.randomUUID()
    candidate.job = null
    if (profile) {
      profiles.value = [profile, ...profiles.value.filter((item) => item.id !== profile.id)].slice(0, 50)
      candidate.resolvedProfileId = profile.id
    } else if (profileId.value) candidate.resolvedProfileId = profileId.value
    await perform((current, path) => submitImport(candidate, current, path))
  }
  async function previewStories() {
    await perform(async (current, path) => {
      const lines = [
        ...new Set(
          urls.value
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ]
      if (!lines.length || lines.length > 100) throw new Error('Enter between 1 and 100 story URLs, one per line.')
      if (lines.some((url) => url.length > 4096 || !/^https:\/\/[^\s]+$/.test(url))) throw new Error('Each story needs a valid HTTPS URL.')
      const selectedProfile = profileId.value
      const prior = new Map(candidates.value.filter((row) => row.profileId === selectedProfile).map((row) => [row.url, row]))
      candidates.value = lines.map(
        (url) =>
          prior.get(url) ?? {
            url,
            profileId: selectedProfile,
            previewKey: crypto.randomUUID(),
            importKey: crypto.randomUUID(),
            selected: true,
            job: null,
            preview: null,
          },
      )
      for (const candidate of candidates.value) {
        if (!currentScope(current)) break
        if (candidate.job) continue
        const job = await request<FanfictionJob>(`${path}/previews`, {
          url: candidate.url,
          idempotencyKey: candidate.previewKey,
          ...(selectedProfile ? { profileId: selectedProfile } : {}),
        })
        if (!currentScope(current)) break
        candidate.job = job
        candidate.preview = job.result?.preview ?? null
      }
    })
  }
  async function importSelected() {
    await perform(async (current, path) => {
      const selectedFolder = folderId.value
      if (selectedFolder === null) return
      const intervalMinutes = schedule.value === 'manual' ? null : Number(schedule.value)
      for (const candidate of candidates.value) {
        if (!currentScope(current)) break
        if (
          candidate.profileId !== profileId.value ||
          !candidate.selected ||
          !candidate.preview ||
          candidate.job?.kind !== 'preview' ||
          candidate.job.state !== 'succeeded'
        )
          continue
        const job = await request<FanfictionJob>(`${path}/sources`, {
          url: candidate.preview.canonicalUrl,
          idempotencyKey: candidate.importKey,
          ...(collectionId.value ? { collectionId: collectionId.value } : {}),
          folderId: selectedFolder,
          intervalMinutes,
          ...(profileId.value ? { profileId: profileId.value } : {}),
        })
        if (!currentScope(current)) break
        candidate.job = job
        candidate.selected = false
      }
      await loadJobs(current, path, null)
    })
  }
  async function cancelJob(job: FanfictionJob) {
    await perform(async (current, path) => {
      await request(`${path}/jobs/${job.id}/cancel`, {})
      if (currentScope(current)) await loadJobs(current, path, jobPage)
    })
  }
  async function retryJob(job: FanfictionJob) {
    await perform(async (current, path) => {
      await request(`${path}/jobs/${job.id}/retry`, {})
      if (currentScope(current)) await loadJobs(current, path, jobPage)
    })
  }
  async function togglePaused(source: FanfictionSource) {
    await perform(async (current, path) => {
      await request(`${path}/sources/${source.id}`, { version: source.version, state: source.state === 'paused' ? 'active' : 'paused' }, 'PATCH')
      if (currentScope(current)) await loadSources(current, path, sourcePage)
    })
  }
  async function checkSource(source: FanfictionSource, kind: 'update' | 'refresh') {
    if (busy.value || ['queued', 'running'].includes(sourceJobs.value[source.id]?.state ?? '')) return
    checkingSourceId.value = source.id
    delete sourceErrors.value[source.id]
    await perform(async (current, path) => {
      const key = `${source.libraryId}:${source.id}:${kind}`
      const idempotencyKey = pendingChecks.get(key) ?? crypto.randomUUID()
      pendingChecks.set(key, idempotencyKey)
      try {
        const job = await request<FanfictionJob>(`${path}/sources/${source.id}/check`, { kind, idempotencyKey })
        if (!currentScope(current)) return
        pendingChecks.delete(key)
        sourceJobs.value[source.id] = job
        await loadJobs(current, path, jobPage)
        schedulePoll(current)
      } catch (failure) {
        if (currentScope(current) && !(failure instanceof MetadataReviewRequiredError))
          sourceErrors.value[source.id] = failure instanceof Error ? failure.message : 'Request failed'
        throw failure
      } finally {
        if (currentScope(current)) checkingSourceId.value = null
      }
    })
  }
  const checkNow = (source: FanfictionSource) => checkSource(source, 'update')
  const refreshChapters = (source: FanfictionSource) => checkSource(source, 'refresh')
  function schedulePoll(current: number) {
    clearTimeout(timer)
    if (!currentScope(current)) return
    timer = setTimeout(
      () => {
        void poll(current)
      },
      candidates.value.some((candidate) => candidate.job && ['queued', 'running'].includes(candidate.job.state)) ? 2000 : 5000,
    )
  }
  async function poll(current: number) {
    if (!currentScope(current)) return
    try {
      if (!busy.value) {
        const path = base.value
        await Promise.all([loadJobs(current, path, jobPage), loadSources(current, path, sourcePage), loadActivity(current, path, activityPage)])
        const ids = [
          ...new Set([
            ...candidates.value.flatMap((candidate) =>
              candidate.job && ['queued', 'running'].includes(candidate.job.state) ? [candidate.job.id] : [],
            ),
            ...Object.values(sourceJobs.value)
              .filter((job) => ['queued', 'running'].includes(job.state))
              .map((job) => job.id),
          ]),
        ]
        if (ids.length && currentScope(current)) {
          const updates: FanfictionJob[] = []
          for (let offset = 0; offset < ids.length; offset += 50) {
            const page = await request<{ items: FanfictionJob[] }>(`${path}/jobs/status`, { ids: ids.slice(offset, offset + 50) })
            if (!currentScope(current)) return
            updates.push(...page.items)
          }
          const byId = new Map(updates.map((job) => [job.id, job]))
          for (const [id, job] of Object.entries(sourceJobs.value)) {
            const updated = byId.get(job.id)
            if (updated) sourceJobs.value[id] = updated
          }
          for (const candidate of candidates.value) {
            const updated = candidate.job && byId.get(candidate.job.id)
            if (updated) {
              candidate.job = updated.result?.existingImportId
                ? await request<FanfictionJob>(`${path}/jobs/${updated.result.existingImportId}`)
                : updated
              candidate.existingStory = updated.result?.existingStory
              if (candidate.existingStory) await continueExisting(candidate, current, path)
              candidate.preview = updated.result?.preview ?? candidate.preview
            }
          }
        }
      }
    } catch (failure) {
      if (currentScope(current)) error.value = failure instanceof Error ? failure.message : 'Request failed'
    } finally {
      schedulePoll(current)
    }
  }
  function showStories() {
    tab.value = 'stories'
  }
  function showAdd() {
    tab.value = 'add'
  }
  function showDiscovery() {
    tab.value = 'discovery'
  }
  function showActivity() {
    tab.value = 'activity'
  }
  onScopeDispose(() => {
    disposed = true
    generation++
    clearTimeout(timer)
  })
  return {
    libraries,
    libraryCursor,
    libraryId,
    folders,
    folderCursor,
    folderId,
    collectionId,
    profiles,
    profileCursor,
    profileId,
    sources,
    sourceCursor,
    jobs,
    jobCursor,
    activity,
    activityCursor,
    moreActivity,
    previousActivity,
    previousSources,
    previousJobs,
    sourcePagination,
    jobPagination,
    activityPagination,
    sourceJobs,
    sourceErrors,
    checkingSourceId,
    applyFilters,
    candidates,
    urls,
    search,
    state,
    filters,
    appliedFilters,
    appliedSearch,
    appliedState,
    schedule,
    busy,
    error,
    tab,
    canImport,
    loadLibraries,
    changeLibrary,
    moreFolders,
    moreProfiles,
    refresh,
    moreSources,
    moreJobs,
    importStories,
    importBatchStarted,
    importBatchActive,
    importBatchPending,
    importBatchFinished,
    importBatchTotal,
    importBatchCompleted,
    importBatchNeedsAttention,
    startAnotherImportBatch,
    existingCandidate,
    existingStoryPosition,
    existingStoryCount,
    hasPreviousExistingStory,
    hasNextExistingStory,
    previousExistingStory,
    nextExistingStory,
    visibleCandidates,
    cancelExistingStory,
    updateExistingStory,
    retryImport,
    acceptImportReview,
    previewStories,
    useSavedProfile,
    importSelected,
    cancelJob,
    retryJob,
    togglePaused,
    checkNow,
    refreshChapters,
    showStories,
    showAdd,
    showActivity,
    showDiscovery,
  }
}

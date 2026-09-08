import { computed, onScopeDispose, ref } from 'vue'
import type {
  FanfictionFolderPage,
  FanfictionJob,
  FanfictionJobPage,
  FanfictionLibraryPage,
  FanfictionPreview,
  FanfictionMetadataEdits,
  FanfictionImportRequest,
  FanfictionProfileMatch,
  FanfictionProfilePage,
  FanfictionProfileSummary,
  FanfictionSource,
  FanfictionSourcePage,
  FanfictionActivity,
  FanfictionActivityPage,
} from '@bookorbit/types'
import { api } from '@/lib/api'

interface Candidate {
  url: string
  profileId: string
  destination?: { folderId: number; intervalMinutes: number | null }
  resolvedProfileId?: string
  previewKey: string
  importKey: string
  dismissed?: boolean
  importRequest?: FanfictionImportRequest
  selected: boolean
  job: FanfictionJob | null
  preview: FanfictionPreview | null
}

export function useFanfiction() {
  const libraries = ref<FanfictionLibraryPage['items']>([])
  const libraryCursor = ref<number | null>(null)
  const libraryId = ref<number | null>(null)
  const folders = ref<FanfictionFolderPage['items']>([])
  const folderCursor = ref<number | null>(null)
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
  const urls = ref('')
  const search = ref('')
  const state = ref('')
  const schedule = ref('1440')
  const busy = ref(false)
  const error = ref('')
  const tab = ref<'stories' | 'add' | 'discovery' | 'activity' | 'profiles'>('stories')
  const base = computed(() => `/api/v1/libraries/${libraryId.value}/fanfiction`)
  const reviewCandidate = computed(() =>
    candidates.value.find((row) => row.preview && row.job?.kind === 'preview' && row.job.state === 'succeeded' && !row.dismissed),
  )
  let generation = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let sourcePage: string | null = null
  let jobPage: string | null = null
  let sourceRequest = 0
  let jobRequest = 0
  let activityRequest = 0
  let activityPage: string | null = null
  const pendingChecks = new Map<string, string>()

  async function request<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
    const response = await api(
      path,
      body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : `HTTP ${response.status}`)
    return result as T
  }
  async function perform(operation: (current: number, path: string) => Promise<void>) {
    const current = generation
    busy.value = true
    error.value = ''
    try {
      await operation(current, base.value)
    } catch (failure) {
      if (current === generation && !disposed) error.value = failure instanceof Error ? failure.message : 'Request failed'
    } finally {
      if (current === generation && !disposed) busy.value = false
    }
  }
  const currentScope = (current: number) => !disposed && current === generation
  function sourceQuery(cursor: string | null) {
    const query = new URLSearchParams({ limit: '50' })
    if (cursor) query.set('cursor', cursor)
    if (search.value) query.set('search', search.value)
    if (state.value) query.set('state', state.value)
    return query.toString()
  }
  async function loadSources(current: number, path: string, cursor: string | null) {
    const requestId = ++sourceRequest
    const page = await request<FanfictionSourcePage>(`${path}/sources?${sourceQuery(cursor)}`)
    if (!currentScope(current) || requestId !== sourceRequest) return
    sources.value = page.items
    sourceCursor.value = page.nextCursor
    sourcePage = cursor
  }
  async function loadJobs(current: number, path: string, cursor: string | null) {
    const requestId = ++jobRequest
    const page = await request<FanfictionJobPage>(`${path}/jobs?limit=50${cursor ? `&cursor=${cursor}` : ''}`)
    if (!currentScope(current) || requestId !== jobRequest) return
    jobs.value = page.items
    jobCursor.value = page.nextCursor
    jobPage = cursor
  }
  async function loadActivity(current: number, path: string, cursor: string | null) {
    const requestId = ++activityRequest
    const page = await request<FanfictionActivityPage>(`${path}/activity?limit=50${cursor ? `&cursor=${cursor}` : ''}`)
    if (!currentScope(current) || requestId !== activityRequest) return
    activity.value = page.items
    activityCursor.value = page.nextCursor
    activityPage = cursor
  }
  async function moreActivity() {
    await perform((current, path) => loadActivity(current, path, activityCursor.value))
  }
  async function loadLibraries() {
    await perform(async (current) => {
      const page = await request<FanfictionLibraryPage>(
        `/api/v1/fanfiction/libraries?limit=50${libraryCursor.value ? `&cursor=${libraryCursor.value}` : ''}`,
      )
      if (!currentScope(current)) return
      libraries.value = page.items
      libraryCursor.value = page.nextCursor
      libraryId.value = page.items[0]?.id ?? null
    })
    await changeLibrary()
  }
  async function changeLibrary() {
    generation++
    clearTimeout(timer)
    candidates.value = []
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
    await perform(async (current, path) => {
      await Promise.all([loadSources(current, path, null), loadJobs(current, path, null), loadActivity(current, path, null)])
    })
  }
  async function moreSources() {
    await perform((current, path) => loadSources(current, path, sourceCursor.value))
  }
  async function moreJobs() {
    await perform((current, path) => loadJobs(current, path, jobCursor.value))
  }
  function useSavedProfile(profile: FanfictionProfileSummary) {
    if (profile.libraryId !== libraryId.value) return
    profiles.value = [profile, ...profiles.value.filter((item) => item.id !== profile.id)].slice(0, 50)
    profileId.value = profile.id
    candidates.value = candidates.value.filter((row) => row.job?.kind === 'import')
  }
  async function submitPreview(candidate: Candidate, current: number, path: string) {
    if (folderId.value === null) return
    candidate.destination ??= { folderId: folderId.value, intervalMinutes: schedule.value === 'manual' ? null : Number(schedule.value) }
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
    const job = await request<FanfictionJob>(`${path}/previews`, {
      url: candidate.url,
      idempotencyKey: candidate.previewKey,
      ...(candidate.resolvedProfileId ? { profileId: candidate.resolvedProfileId } : {}),
    })
    if (!currentScope(current)) return
    candidate.job = job
    candidate.preview = job.result?.preview ?? null
    candidate.dismissed = false
    schedulePoll(current)
  }
  async function reviewStories() {
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
      const prior = new Map(candidates.value.map((row) => [row.url, row]))
      candidates.value = lines.map(
        (url) =>
          (prior.get(url)?.profileId === profileId.value || prior.get(url)?.job?.kind === 'import' ? prior.get(url) : undefined) ?? {
            url,
            profileId: profileId.value,
            previewKey: crypto.randomUUID(),
            importKey: crypto.randomUUID(),
            selected: true,
            job: null,
            preview: null,
          },
      )
      for (const candidate of candidates.value) {
        if (!currentScope(current)) break
        if (candidate.job) {
          candidate.dismissed = false
          continue
        }
        await submitPreview(candidate, current, path)
      }
    })
  }
  async function retryImport(candidate: Candidate, profile?: FanfictionProfileSummary) {
    if (busy.value || !candidate.job || !['configuration_blocked', 'failed', 'cancelled'].includes(candidate.job.state)) return
    if (profile && profile.libraryId !== libraryId.value) return
    if (candidate.job.kind === 'preview') {
      candidate.resolvedProfileId = profile?.id ?? (profileId.value || candidate.resolvedProfileId)
      candidate.previewKey = crypto.randomUUID()
      candidate.job = null
      candidate.preview = null
      if (profile) profiles.value = [profile, ...profiles.value.filter((item) => item.id !== profile.id)].slice(0, 50)
      await perform((current, path) => submitPreview(candidate, current, path))
      return
    }
    const id = candidate.job.id
    const selectedProfile = profile?.id ?? (profileId.value || candidate.resolvedProfileId)
    await perform(async (current, path) => {
      const job = await request<FanfictionJob>(`${path}/jobs/${id}/retry`, selectedProfile ? { profileId: selectedProfile } : {})
      if (!currentScope(current)) return
      candidate.job = job
      candidate.resolvedProfileId = selectedProfile
      if (profile) profiles.value = [profile, ...profiles.value.filter((item) => item.id !== profile.id)].slice(0, 50)
      schedulePoll(current)
    })
  }
  function dismissReview() {
    if (busy.value) return
    if (reviewCandidate.value) reviewCandidate.value.dismissed = true
  }
  function reopenReview(candidate: Candidate) {
    candidate.dismissed = false
  }
  async function confirmReview(metadata: FanfictionMetadataEdits) {
    const candidate = reviewCandidate.value
    if (busy.value || !candidate?.preview || !candidate.destination) return
    candidate.importRequest ??= {
      url: candidate.preview.canonicalUrl,
      ...candidate.destination,
      idempotencyKey: candidate.importKey,
      ...(candidate.resolvedProfileId ? { profileId: candidate.resolvedProfileId } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    }
    await perform(async (current, path) => {
      const job = await request<FanfictionJob>(`${path}/sources`, candidate.importRequest)
      if (!currentScope(current)) return
      candidate.job = job
      candidate.selected = false
      schedulePoll(current)
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
    await perform(async (current, path) => {
      const key = `${source.libraryId}:${source.id}:${kind}`
      const idempotencyKey = pendingChecks.get(key) ?? crypto.randomUUID()
      pendingChecks.set(key, idempotencyKey)
      await request<FanfictionJob>(`${path}/sources/${source.id}/check`, { kind, idempotencyKey })
      pendingChecks.delete(key)
      if (currentScope(current)) await loadJobs(current, path, null)
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
        const ids = candidates.value.flatMap((candidate) =>
          candidate.job && ['queued', 'running'].includes(candidate.job.state) ? [candidate.job.id] : [],
        )
        if (ids.length && currentScope(current)) {
          const page = await request<{ items: FanfictionJob[] }>(`${path}/jobs/status`, { ids })
          if (!currentScope(current)) return
          const byId = new Map(page.items.map((job) => [job.id, job]))
          for (const candidate of candidates.value) {
            const updated = candidate.job && byId.get(candidate.job.id)
            if (updated) {
              candidate.job = updated
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
    candidates,
    urls,
    search,
    state,
    schedule,
    busy,
    error,
    tab,
    reviewCandidate,
    dismissReview,
    reopenReview,
    confirmReview,
    loadLibraries,
    changeLibrary,
    moreFolders,
    moreProfiles,
    refresh,
    moreSources,
    moreJobs,
    reviewStories,
    retryImport,
    useSavedProfile,
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

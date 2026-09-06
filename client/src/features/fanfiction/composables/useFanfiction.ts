import { computed, onScopeDispose, ref } from 'vue'
import type {
  FanfictionFolderPage,
  FanfictionJob,
  FanfictionJobPage,
  FanfictionLibraryPage,
  FanfictionPreview,
  FanfictionProfilePage,
  FanfictionSource,
  FanfictionSourcePage,
  FanfictionActivity,
  FanfictionActivityPage,
} from '@bookorbit/types'
import { api } from '@/lib/api'

interface Candidate {
  url: string
  profileId: string
  previewKey: string
  importKey: string
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
  const tab = ref<'stories' | 'add' | 'discovery' | 'activity'>('stories')
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
    timer = setTimeout(() => {
      void poll(current)
    }, 5000)
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
    canImport,
    loadLibraries,
    changeLibrary,
    moreFolders,
    moreProfiles,
    refresh,
    moreSources,
    moreJobs,
    previewStories,
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

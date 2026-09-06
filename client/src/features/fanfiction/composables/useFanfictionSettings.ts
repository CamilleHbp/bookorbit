import { computed, onScopeDispose, ref } from 'vue'
import type {
  FanficfareRuntimeHealth,
  FanfictionJob,
  FanfictionJobPage,
  FanfictionLibraryPage,
  FanfictionProfilePage,
  FanfictionProfileSummary,
  FanfictionProfileView,
  FanfictionCookie,
} from '@bookorbit/types'
import { api } from '@/lib/api'

export function useFanfictionSettings() {
  const libraries = ref<FanfictionLibraryPage['items']>([])
  const libraryCursor = ref<number | null>(null)
  const libraryId = ref<number | null>(null)
  const profiles = ref<FanfictionProfileSummary[]>([])
  const profileCursor = ref<string | null>(null)
  const health = ref<FanficfareRuntimeHealth | null>(null)
  const jobs = ref<FanfictionJob[]>([])
  const jobCursor = ref<string | null>(null)
  const busy = ref(false)
  const error = ref('')
  const editing = ref<FanfictionProfileView | null>(null)
  const showEditor = ref(false)
  const name = ref('')
  const configuration = ref('')
  const section = ref('defaults')
  const username = ref('')
  const password = ref('')
  const usernameChanged = ref(false)
  const passwordChanged = ref(false)
  const cookies = ref<(FanfictionCookie & { key: string })[]>([])
  const cookiesChanged = ref(false)
  const cookiePage = ref(0)
  const cookieRows = computed(() => cookies.value.slice(cookiePage.value * 10, cookiePage.value * 10 + 10))
  const moreCookies = computed(() => (cookiePage.value + 1) * 10 < cookies.value.length)
  const previewUrl = ref('')
  const previewProfileId = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let disposed = false
  let pendingPreview: { signature: string; id: string } | null = null
  const base = computed(() => `/api/v1/libraries/${libraryId.value}/fanfiction`)

  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await api(path, options)
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body.message === 'string' ? body.message : `HTTP ${response.status}`)
    return body as T
  }
  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  async function perform(action: () => Promise<void>) {
    busy.value = true
    error.value = ''
    try {
      await action()
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : 'Request failed'
    } finally {
      busy.value = false
    }
  }
  async function loadLibraries() {
    await perform(async () => {
      const page = await request<FanfictionLibraryPage>(
        `/api/v1/fanfiction/libraries?limit=50${libraryCursor.value ? `&cursor=${libraryCursor.value}` : ''}`,
      )
      libraries.value = page.items
      libraryCursor.value = page.nextCursor
      if (!page.items.some((item) => item.id === libraryId.value) && page.items[0]) libraryId.value = page.items[0].id
    })
    if (libraryId.value !== null) await reload()
  }
  async function reload() {
    clearTimeout(timer)
    const current = ++generation
    clearEditor()
    showEditor.value = false
    profiles.value = []
    jobs.value = []
    health.value = null
    previewProfileId.value = ''
    if (libraryId.value === null) return
    const path = base.value
    await perform(async () => {
      const [runtime, profilePage, activity] = await Promise.all([
        request<FanficfareRuntimeHealth>(`${path}/runtime`),
        request<FanfictionProfilePage>(`${path}/profiles?limit=50`),
        request<FanfictionJobPage>(`${path}/jobs?limit=50`),
      ])
      if (current !== generation || disposed) return
      health.value = runtime
      profiles.value = profilePage.items
      profileCursor.value = profilePage.nextCursor
      jobs.value = activity.items
      jobCursor.value = activity.nextCursor
    })
    schedulePoll(current)
  }
  function schedulePoll(current: number) {
    clearTimeout(timer)
    if (disposed || current !== generation) return
    timer = setTimeout(() => {
      void poll(current)
    }, 5000)
  }
  async function poll(current: number) {
    if (disposed || current !== generation) return
    try {
      const page = await request<FanfictionJobPage>(`${base.value}/jobs?limit=50`)
      if (current !== generation || disposed) return
      jobs.value = page.items
      jobCursor.value = page.nextCursor
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : 'Request failed'
    } finally {
      schedulePoll(current)
    }
  }
  async function moreProfiles() {
    if (!profileCursor.value) return
    const current = generation
    await perform(async () => {
      const page = await request<FanfictionProfilePage>(`${base.value}/profiles?limit=50&cursor=${profileCursor.value}`)
      if (current !== generation) return
      profiles.value = page.items
      profileCursor.value = page.nextCursor
    })
  }
  async function moreJobs() {
    if (!jobCursor.value) return
    clearTimeout(timer)
    const current = ++generation
    await perform(async () => {
      const page = await request<FanfictionJobPage>(`${base.value}/jobs?limit=50&cursor=${jobCursor.value}`)
      if (current !== generation) return
      jobs.value = page.items
      jobCursor.value = page.nextCursor
    })
  }
  function clearEditor() {
    editing.value = null
    name.value = ''
    configuration.value = ''
    section.value = 'defaults'
    username.value = ''
    password.value = ''
    usernameChanged.value = false
    passwordChanged.value = false
    cookies.value = []
    cookiesChanged.value = false
    cookiePage.value = 0
  }
  function newProfile() {
    clearEditor()
    showEditor.value = true
  }
  function closeEditor() {
    clearEditor()
    showEditor.value = false
  }
  async function editProfile(profile: FanfictionProfileSummary) {
    const current = generation
    await perform(async () => {
      const view = await request<FanfictionProfileView>(`${base.value}/profiles/${profile.id}`)
      if (current !== generation) return
      clearEditor()
      editing.value = view
      name.value = view.name
      configuration.value = view.configuration
      cookies.value = (view.cookies ?? []).map((cookie) => ({ ...cookie, key: crypto.randomUUID() }))
      showEditor.value = true
    })
  }
  function changeUsername() {
    usernameChanged.value = true
  }
  function changePassword() {
    passwordChanged.value = true
  }
  function clearPassword() {
    password.value = ''
    passwordChanged.value = true
  }
  function changeCookies() {
    cookiesChanged.value = true
  }
  function addCookie() {
    if (cookies.value.length >= 200) return
    cookies.value.push({ key: crypto.randomUUID(), name: '', value: '', domain: '', path: '/', secure: true })
    cookiePage.value = Math.floor((cookies.value.length - 1) / 10)
    changeCookies()
  }
  function removeCookie(key: string) {
    cookies.value = cookies.value.filter((cookie) => cookie.key !== key)
    cookiePage.value = Math.min(cookiePage.value, Math.max(0, Math.ceil(cookies.value.length / 10) - 1))
    changeCookies()
  }
  function clearCookies() {
    cookies.value = []
    cookiePage.value = 0
    changeCookies()
  }
  function nextCookies() {
    if (moreCookies.value) cookiePage.value++
  }
  function previousCookies() {
    cookiePage.value = Math.max(0, cookiePage.value - 1)
  }
  async function saveProfile() {
    const current = generation
    await perform(async () => {
      const credentials =
        usernameChanged.value || passwordChanged.value
          ? {
              section: section.value,
              ...(usernameChanged.value ? { username: username.value } : {}),
              ...(passwordChanged.value ? { password: password.value } : {}),
            }
          : undefined
      await request(
        `${base.value}/profiles${editing.value ? `/${editing.value.id}` : ''}`,
        json(
          {
            name: name.value,
            configuration: configuration.value,
            credentials,
            ...(editing.value ? { version: editing.value.version } : {}),
            ...(cookiesChanged.value ? { cookies: cookies.value.map(({ key: _key, ...cookie }) => cookie) } : {}),
          },
          editing.value ? 'PATCH' : 'POST',
        ),
      )
      if (current !== generation) return
      closeEditor()
      const page = await request<FanfictionProfilePage>(`${base.value}/profiles?limit=50`)
      profiles.value = page.items
      profileCursor.value = page.nextCursor
    })
  }
  async function preview() {
    const current = generation
    const signature = JSON.stringify([libraryId.value, previewUrl.value, previewProfileId.value])
    if (pendingPreview?.signature !== signature) pendingPreview = { signature, id: crypto.randomUUID() }
    const idempotencyKey = pendingPreview.id
    await perform(async () => {
      const job = await request<FanfictionJob>(
        `${base.value}/previews`,
        json({ url: previewUrl.value, profileId: previewProfileId.value || undefined, idempotencyKey }),
      )
      pendingPreview = null
      if (current !== generation) return
      jobs.value = [job, ...jobs.value].slice(0, 50)
      schedulePoll(current)
    })
  }
  async function cancelJob(job: FanfictionJob) {
    await perform(async () => {
      const value = await request<FanfictionJob>(`${base.value}/jobs/${job.id}/cancel`, json({}))
      jobs.value = jobs.value.map((item) => (item.id === value.id ? value : item))
    })
  }
  onScopeDispose(() => {
    disposed = true
    generation++
    clearTimeout(timer)
    clearEditor()
  })
  return {
    libraries,
    libraryCursor,
    libraryId,
    profiles,
    profileCursor,
    health,
    jobs,
    jobCursor,
    busy,
    error,
    editing,
    showEditor,
    name,
    configuration,
    section,
    username,
    password,
    cookies,
    cookieRows,
    cookiePage,
    moreCookies,
    changeCookies,
    addCookie,
    removeCookie,
    clearCookies,
    nextCookies,
    previousCookies,
    previewUrl,
    previewProfileId,
    loadLibraries,
    reload,
    moreProfiles,
    moreJobs,
    newProfile,
    closeEditor,
    editProfile,
    changeUsername,
    changePassword,
    clearPassword,
    saveProfile,
    preview,
    cancelJob,
  }
}

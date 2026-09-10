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
  FanfictionTagRule,
} from '@bookorbit/types'
import { api } from '@/lib/api'
import { sourcePresets } from '../lib/source-presets'

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
  const deleting = ref<FanfictionProfileSummary | null>(null)
  const name = ref('')
  const rootUrls = ref('')
  const configuration = ref('')
  const tagRules = ref<FanfictionTagRule[]>([])
  const section = ref('defaults')
  const presetId = ref('')
  const preset = computed(() => sourcePresets.find((item) => item.id === presetId.value))
  const isAdult = ref(false)
  const adultChanged = ref(false)
  function readSection() {
    presetId.value = sourcePresets.find((item) => item.section === section.value)?.id ?? ''
    const values = new Map<string, Record<string, string>>()
    let current = ''
    for (const line of configuration.value.split(/\r?\n/)) {
      const header = line.match(/^\[([^\]]+)\]\s*$/)
      if (header) {
        current = header[1]!
        values.set(current, {})
      } else {
        const entry = line.match(/^(username|password|is_adult)\s*[:=]\s*(.*)$/i)
        if (entry && values.has(current)) values.get(current)![entry[1]!.toLowerCase()] = entry[2]!.trim()
      }
    }
    const effective = { ...values.get('defaults'), ...values.get(section.value) }
    username.value = effective.username ?? ''
    password.value = effective.password ?? ''
    isAdult.value = effective.is_adult?.toLowerCase() === 'true'
    usernameChanged.value = false
    passwordChanged.value = false
    adultChanged.value = false
  }
  function changeAdult() {
    adultChanged.value = true
  }
  function applyPreset() {
    if (editing.value) return
    if (!preset.value) {
      clearEditor()
      return
    }
    rootUrls.value = preset.value.hosts.map((host) => `https://${host}`).join('\n')
    name.value = preset.value.name
    section.value = preset.value.section
    configuration.value = preset.value.configuration
    cookies.value = []
    cookiesChanged.value = false
    cookiePage.value = 0
    username.value = ''
    password.value = ''
    usernameChanged.value = false
    passwordChanged.value = false
    isAdult.value = false
    adultChanged.value = false
  }

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
    const current = generation
    busy.value = true
    error.value = ''
    try {
      await action()
    } catch (failure) {
      if (current === generation && !disposed) error.value = failure instanceof Error ? failure.message : 'Request failed'
    } finally {
      if (current === generation && !disposed) busy.value = false
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
  function setLibrary(id: number | null) {
    clearTimeout(timer)
    generation++
    libraryId.value = id
    busy.value = false
    clearEditor()
    showEditor.value = false
    deleting.value = null
    error.value = ''
  }
  async function reload() {
    clearTimeout(timer)
    const current = ++generation
    clearEditor()
    showEditor.value = false
    deleting.value = null
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
    rootUrls.value = ''
    configuration.value = ''
    tagRules.value = []
    section.value = 'defaults'
    presetId.value = ''
    isAdult.value = false
    adultChanged.value = false
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
      rootUrls.value = (view.rootUrls ?? []).join('\n')
      name.value = view.name
      configuration.value = view.configuration
      tagRules.value = structuredClone(view.tagRules ?? [])
      const sections = [...view.configuration.matchAll(/^\[([^\]\r\n]+)\]\s*$/gm)].map((match) => match[1])
      const known = sourcePresets.filter((item) => sections.includes(item.section))
      if (known.length === 1) {
        presetId.value = known[0]!.id
        section.value = known[0]!.section
      } else if (sections.length === 1 && sections[0]) section.value = sections[0]

      readSection()
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
    if (busy.value) return
    const current = generation
    let saved: FanfictionProfileSummary | undefined
    await perform(async () => {
      const credentials =
        usernameChanged.value || passwordChanged.value || adultChanged.value
          ? {
              section: section.value,
              ...(adultChanged.value ? { isAdult: isAdult.value } : {}),
              ...(usernameChanged.value ? { username: username.value } : {}),
              ...(passwordChanged.value ? { password: password.value } : {}),
            }
          : undefined
      const result = await request<FanfictionProfileSummary>(
        `${base.value}/profiles${editing.value ? `/${editing.value.id}` : ''}`,
        json(
          {
            name: name.value,
            rootUrls: rootUrls.value
              .split(/\r?\n/)
              .map((url) => url.trim())
              .filter(Boolean),
            configuration: configuration.value,
            tagRules: tagRules.value,
            credentials,
            ...(editing.value ? { version: editing.value.version } : {}),
            ...(cookiesChanged.value ? { cookies: cookies.value.map(({ key: _key, ...cookie }) => cookie) } : {}),
          },
          editing.value ? 'PATCH' : 'POST',
        ),
      )
      if (current !== generation) return
      saved = result
      previewProfileId.value = result.id
      closeEditor()
      const page = await request<FanfictionProfilePage>(`${base.value}/profiles?limit=50`)
      if (current !== generation || disposed) return
      profiles.value = [result, ...page.items.filter((item) => item.id !== result.id)]
      profileCursor.value = page.nextCursor
    })
    return saved
  }
  function requestDelete(profile: FanfictionProfileSummary) {
    if (busy.value) return
    error.value = ''
    deleting.value = profile
  }
  function cancelDelete() {
    if (!busy.value) deleting.value = null
  }
  async function deleteProfile() {
    if (busy.value || !deleting.value) return
    const current = generation
    const id = deleting.value.id
    let deleted: string | undefined
    await perform(async () => {
      await request<void>(`${base.value}/profiles/${id}`, { method: 'DELETE' })
      if (current !== generation || disposed) return
      profiles.value = profiles.value.filter((profile) => profile.id !== id)
      if (editing.value?.id === id) closeEditor()
      if (previewProfileId.value === id) previewProfileId.value = ''
      deleting.value = null
      deleted = id
    })
    return deleted
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
    deleting,
    requestDelete,
    cancelDelete,
    deleteProfile,
    name,
    rootUrls,
    configuration,
    tagRules,
    section,
    presetId,
    preset,
    isAdult,
    adultChanged,
    changeAdult,
    applyPreset,
    readSection,
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
    setLibrary,
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

import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type {
  FanfictionConnection,
  FanfictionConnectionIssue,
  FanfictionConnectionRequest,
  FanfictionJob,
  FanfictionSource,
  FanfictionWebsite,
} from '@bookorbit/types'
import { api } from '@/lib/api'

export function useWebsiteConnections(libraryId: MaybeRefOrGetter<number | undefined>) {
  const websites = ref<FanfictionWebsite[]>([])
  const connections = ref<FanfictionConnection[]>([])
  const issues = ref<FanfictionConnectionIssue[]>([])
  const site = ref('')
  const username = ref('')
  const password = ref('')
  const cookieName = ref('')
  const cookieValue = ref('')
  const error = ref('')
  const busy = ref(false)
  const saved = ref(false)
  const website = computed(() => websites.value.find((item) => item.id === site.value))
  const connection = computed(() => connections.value.find((item) => item.website.id === site.value))
  const affected = computed(() => issues.value.find((item) => item.site === site.value)?.count ?? 0)
  const controllers = new Set<AbortController>()
  let generation = 0
  let disposed = false
  const base = '/api/v1/fanfiction/connections'
  async function request<T>(url: string, body?: unknown, method = 'POST'): Promise<T> {
    const controller = new AbortController()
    controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 30000)
    try {
      const response = await api(url, {
        signal: controller.signal,
        ...(body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : `HTTP ${response.status}`)
      return result as T
    } finally {
      clearTimeout(timeout)
      controllers.delete(controller)
    }
  }
  async function reload() {
    const current = ++generation
    for (const controller of controllers) controller.abort()
    busy.value = true
    error.value = ''
    try {
      const id = toValue(libraryId)
      const [catalog, logins, problems] = await Promise.all([
        request<FanfictionWebsite[]>(`${base}/websites`),
        request<FanfictionConnection[]>(base),
        id ? request<FanfictionConnectionIssue[]>(`${base}/issues/${id}`) : Promise.resolve([]),
      ])
      if (disposed || current !== generation) return
      if (!Array.isArray(catalog) || !Array.isArray(logins) || !Array.isArray(problems)) throw new Error('Website logins could not be loaded')
      websites.value = catalog
      connections.value = logins
      issues.value = problems
    } catch (failure) {
      if (!disposed && current === generation) error.value = failure instanceof Error ? failure.message : 'Website logins could not be loaded'
    } finally {
      if (!disposed && current === generation) busy.value = false
    }
  }
  function select(value: string) {
    site.value = value.replace(/^www\./, '')
    saved.value = false
    error.value = ''
  }
  watch(site, () => {
    username.value = ''
    password.value = ''
    cookieName.value = ''
    cookieValue.value = ''
    saved.value = false
  })
  async function save(source?: FanfictionSource): Promise<{ connection: FanfictionConnection; job?: FanfictionJob } | undefined> {
    if (busy.value || !website.value) return
    const current = generation
    const id = toValue(libraryId)
    busy.value = true
    error.value = ''
    saved.value = false
    try {
      if (!!cookieName.value !== !!cookieValue.value) throw new Error('Enter both the cookie name and value')
      const body: FanfictionConnectionRequest = {
        site: site.value,
        version: connection.value?.version,
        ...(username.value ? { username: username.value } : {}),
        ...(password.value ? { password: password.value } : {}),
        ...(cookieName.value ? { cookies: [{ name: cookieName.value, value: cookieValue.value, domain: site.value, path: '/', secure: true }] } : {}),
      }
      const result = await request<FanfictionConnection>(base, body)
      if (disposed || current !== generation) return
      connections.value = [result, ...connections.value.filter((item) => item.id !== result.id)]
      password.value = ''
      username.value = ''
      cookieValue.value = ''
      cookieName.value = ''
      if (source && id)
        await request(`/api/v1/libraries/${id}/fanfiction/sources/${source.id}`, { version: source.version, usePersonalConnection: true }, 'PATCH')
      const job =
        id && (affected.value > 0 || (source && (source.tracking?.enabled ?? source.state !== 'paused')))
          ? await request<FanfictionJob>(`${base}/${result.id}/retry`, { libraryId: id })
          : undefined
      if (disposed || current !== generation) return
      saved.value = true
      return { connection: result, job }
    } catch (failure) {
      if (!disposed && current === generation) error.value = failure instanceof Error ? failure.message : 'Website login could not be saved'
    } finally {
      if (!disposed && current === generation) busy.value = false
    }
  }
  async function remove() {
    if (!connection.value || busy.value) return
    const current = generation
    const id = connection.value.id
    busy.value = true
    error.value = ''
    try {
      await request(`${base}/${id}`, {}, 'DELETE')
      if (!disposed && current === generation) {
        connections.value = connections.value.filter((item) => item.id !== id)
        select('')
      }
    } catch (failure) {
      if (!disposed && current === generation) error.value = failure instanceof Error ? failure.message : 'Website login could not be removed'
    } finally {
      if (!disposed && current === generation) busy.value = false
    }
  }
  watch(() => toValue(libraryId), reload, { immediate: true })
  onScopeDispose(() => {
    disposed = true
    generation++
    for (const controller of controllers) controller.abort()
  })
  return {
    websites,
    connections,
    issues,
    site,
    username,
    password,
    cookieName,
    cookieValue,
    error,
    busy,
    saved,
    website,
    connection,
    affected,
    select,
    save,
    remove,
    reload,
  }
}

import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import {
  Permission,
  type KoreaderDeliveryJob,
  type KoreaderDeliveryJobPage,
  type KoreaderInstalledCopy,
  type RequestKoreaderDelivery,
} from '@bookorbit/types'
import { api } from '@/lib/api'
import { usePermissions } from '@/features/auth/composables/usePermissions'

export function useKoreaderDelivery(copy: MaybeRefOrGetter<KoreaderInstalledCopy>) {
  const { hasPermission } = usePermissions()
  const permitted = computed(() => hasPermission(Permission.KoreaderSync))
  const canDownload = computed(() => hasPermission(Permission.LibraryDownload))
  const supported = computed(() => toValue(copy).deliveryCapabilityVersion >= 1 && toValue(copy).positionCapabilityVersion >= 1)
  const canRequest = computed(
    () =>
      permitted.value &&
      canDownload.value &&
      supported.value &&
      !!toValue(copy).currentRevisionId &&
      !!toValue(copy).currentSha256 &&
      toValue(copy).currentSha256 !== toValue(copy).sha256,
  )
  const jobs = ref<KoreaderDeliveryJob[]>([])
  const nextCursor = ref<string | null>(null)
  const busy = ref(false)
  const error = ref('')
  let generation = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let currentCursor: string | undefined
  let requestIdentity: { revisionId: string; key: string } | undefined
  const current = (id: number) => !disposed && generation === id && permitted.value

  async function request<T>(url: string, body?: unknown): Promise<T> {
    const response = await api(
      url,
      body === undefined
        ? undefined
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    )
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : `HTTP ${response.status}`)
    return result as T
  }
  function schedule(id: number) {
    clearTimeout(timer)
    if (!current(id)) return
    timer = setTimeout(() => {
      void perform((token) => load(token, currentCursor))
    }, 5000)
  }
  async function perform(operation: (id: number) => Promise<void>) {
    if (!permitted.value || busy.value) return
    const id = generation
    busy.value = true
    error.value = ''
    clearTimeout(timer)
    try {
      await operation(id)
    } catch (failure) {
      if (current(id)) error.value = failure instanceof Error ? failure.message : 'Request failed'
    } finally {
      if (current(id)) {
        busy.value = false
        schedule(id)
      }
    }
  }
  async function load(id: number, cursor?: string) {
    const query = new URLSearchParams({ installedCopyId: toValue(copy).id, limit: '25' })
    if (cursor) query.set('cursor', cursor)
    const page = await request<KoreaderDeliveryJobPage>(`/api/v1/koreader/deliveries?${query}`)
    if (!current(id)) return
    jobs.value = page.items
    nextCursor.value = page.nextCursor
    currentCursor = cursor
  }
  const refresh = () => perform((id) => load(id))
  const nextPage = () => perform((id) => load(id, nextCursor.value ?? undefined))
  async function requestDelivery() {
    if (!canRequest.value) return
    const revisionId = toValue(copy).currentRevisionId!
    if (requestIdentity?.revisionId !== revisionId) requestIdentity = { revisionId, key: crypto.randomUUID() }
    const body: RequestKoreaderDelivery = { idempotencyKey: requestIdentity.key, expectedRevisionId: revisionId }
    await perform(async (id) => {
      const result = await request<KoreaderDeliveryJob>(`/api/v1/koreader/deliveries/copies/${toValue(copy).id}`, body)
      if (!current(id)) return
      requestIdentity = undefined
      jobs.value = [result]
      nextCursor.value = null
      currentCursor = undefined
      await load(id)
    })
  }
  const canCancel = (job: KoreaderDeliveryJob) => permitted.value && !job.cancelledAt && job.installationState !== 'installed'
  const canRetry = (job: KoreaderDeliveryJob) =>
    canDownload.value &&
    supported.value &&
    job.revisionId === toValue(copy).currentRevisionId &&
    job.installationState !== 'installed' &&
    (!!job.cancelledAt || !!job.failureCode)
  async function change(job: KoreaderDeliveryJob, action: 'cancel' | 'retry') {
    if (!(action === 'cancel' ? canCancel(job) : canRetry(job))) return
    await perform(async (id) => {
      const updated = await request<KoreaderDeliveryJob>(`/api/v1/koreader/deliveries/${job.id}/${action}`, { version: job.version })
      if (current(id)) jobs.value = jobs.value.map((row) => (row.id === updated.id ? updated : row))
    })
  }
  const cancel = (job: KoreaderDeliveryJob) => change(job, 'cancel')
  const retry = (job: KoreaderDeliveryJob) => change(job, 'retry')
  watch(
    () => [toValue(copy).id, permitted.value],
    () => {
      generation++
      clearTimeout(timer)
      jobs.value = []
      nextCursor.value = null
      currentCursor = undefined
      requestIdentity = undefined
      busy.value = false
      error.value = ''
      void refresh()
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    disposed = true
    generation++
    clearTimeout(timer)
  })
  return { permitted, supported, canRequest, jobs, nextCursor, busy, error, refresh, nextPage, requestDelivery, canCancel, canRetry, cancel, retry }
}

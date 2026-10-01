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

class DeliveryRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export function useKoreaderDelivery(copy: MaybeRefOrGetter<KoreaderInstalledCopy>) {
  const { hasPermission } = usePermissions()
  const permitted = computed(() => hasPermission(Permission.KoreaderSync))
  const canDownload = computed(() => hasPermission(Permission.LibraryDownload))
  const supported = computed(() => toValue(copy).deliveryCapabilityVersion >= 1 && toValue(copy).positionCapabilityVersion >= 1)
  const jobs = ref<KoreaderDeliveryJob[]>([])
  const canRequest = computed(
    () =>
      permitted.value &&
      canDownload.value &&
      supported.value &&
      !!toValue(copy).currentRevisionId &&
      !!toValue(copy).currentSha256 &&
      toValue(copy).currentSha256 !== toValue(copy).sha256 &&
      !jobs.value.some((job) => job.revisionId === toValue(copy).currentRevisionId),
  )
  const nextCursor = ref<string | null>(null)
  const busy = ref(false)
  const error = ref('')
  let generation = 0
  let disposed = false
  let failures = 0
  let pollingBlocked = false
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
    if (!response.ok) throw new DeliveryRequestError(typeof result.message === 'string' ? result.message : `HTTP ${response.status}`, response.status)
    return result as T
  }
  function schedule(id: number) {
    clearTimeout(timer)
    if (!current(id) || pollingBlocked || failures >= 5 || document.hidden || !navigator.onLine) return
    const installing = jobs.value.some((job) => !job.cancelledAt && !job.failureCode && job.installationState !== 'installed')
    const restoring = jobs.value.some((job) => job.installationState === 'installed' && job.restorationState === 'verification_pending')
    const selected = toValue(copy)
    const awaitingAutomatic =
      !currentCursor &&
      selected.policy === 'automatic' &&
      selected.policyAcknowledged &&
      canRequest.value &&
      !jobs.value.some((job) => job.revisionId === selected.currentRevisionId)
    if (!failures && !installing && !restoring && !awaitingAutomatic) return
    const delay = failures ? Math.min(60_000, 5000 * 2 ** (failures - 1)) : installing || awaitingAutomatic ? 5000 : 30_000
    timer = setTimeout(() => {
      void perform((token) => load(token, currentCursor), true)
    }, delay)
  }
  async function perform(operation: (id: number) => Promise<void>, background = false) {
    if (!permitted.value || busy.value) return
    const id = generation
    busy.value = true
    if (!background) {
      error.value = ''
      failures = 0
      pollingBlocked = false
    }
    clearTimeout(timer)
    try {
      await operation(id)
      if (current(id)) {
        error.value = ''
        failures = 0
      }
    } catch (failure) {
      if (current(id)) {
        error.value = failure instanceof Error ? failure.message : 'Request failed'
        failures++
        pollingBlocked = failure instanceof DeliveryRequestError && [400, 401, 403, 404].includes(failure.status)
      }
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
    permitted.value &&
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
    () => {
      const selected = toValue(copy)
      return [
        selected.id,
        selected.currentRevisionId,
        selected.sha256,
        selected.policy,
        selected.policyAcknowledged,
        supported.value,
        permitted.value,
      ]
    },
    () => {
      generation++
      clearTimeout(timer)
      jobs.value = []
      nextCursor.value = null
      currentCursor = undefined
      requestIdentity = undefined
      busy.value = false
      error.value = ''
      failures = 0
      pollingBlocked = false
      void refresh()
    },
    { immediate: true },
  )
  function resumePolling() {
    clearTimeout(timer)
    if (!document.hidden && navigator.onLine && !pollingBlocked) void refresh()
  }
  document.addEventListener('visibilitychange', resumePolling)
  window.addEventListener('online', resumePolling)
  window.addEventListener('offline', resumePolling)
  onScopeDispose(() => {
    disposed = true
    generation++
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', resumePolling)
    window.removeEventListener('online', resumePolling)
    window.removeEventListener('offline', resumePolling)
  })
  return { permitted, supported, canRequest, jobs, nextCursor, busy, error, refresh, nextPage, requestDelivery, canCancel, canRetry, cancel, retry }
}

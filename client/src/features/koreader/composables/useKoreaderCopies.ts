import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import {
  Permission,
  type KoreaderDeliveryDevice,
  type KoreaderDeliveryDevicePage,
  type KoreaderDeliveryPolicy,
  type KoreaderInstalledCopy,
  type KoreaderInstalledCopyPage,
  type KoreaderCopyPolicyUpdate,
  type KoreaderDevicePolicyUpdate,
} from '@bookorbit/types'
import { api } from '@/lib/api'
import { usePermissions } from '@/features/auth/composables/usePermissions'

export function useKoreaderCopies(bookFileId: MaybeRefOrGetter<number | undefined>) {
  const { hasPermission } = usePermissions()
  const permitted = computed(() => hasPermission(Permission.KoreaderSync))
  const canDownload = computed(() => hasPermission(Permission.LibraryDownload))
  const copies = ref<KoreaderInstalledCopy[]>([])
  const devices = ref<KoreaderDeliveryDevice[]>([])
  const copyCursor = ref<string | null>(null)
  const deviceCursor = ref<string | null>(null)
  const deviceId = ref('')
  const busy = ref(false)
  const error = ref('')
  const copyPolicies = ref<Record<string, KoreaderDeliveryPolicy | ''>>({})
  const devicePolicies = ref<Record<string, KoreaderDeliveryPolicy>>({})
  let generation = 0
  let disposed = false
  const current = (id: number) => !disposed && id === generation && permitted.value

  async function request<T>(url: string, body?: unknown): Promise<T> {
    const response = await api(
      url,
      body === undefined
        ? undefined
        : {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    )
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : `HTTP ${response.status}`)
    return result as T
  }
  async function perform(operation: (id: number) => Promise<void>) {
    if (!permitted.value || busy.value) return
    const id = generation
    busy.value = true
    error.value = ''
    try {
      await operation(id)
    } catch (failure) {
      if (current(id)) error.value = failure instanceof Error ? failure.message : 'Request failed'
    } finally {
      if (current(id)) busy.value = false
    }
  }
  async function loadCopies(id: number, cursor?: string) {
    const query = new URLSearchParams({ limit: '50' })
    if (cursor) query.set('cursor', cursor)
    if (deviceId.value) query.set('deviceId', deviceId.value)
    const file = toValue(bookFileId)
    if (file !== undefined) query.set('bookFileId', String(file))
    const page = await request<KoreaderInstalledCopyPage>(`/api/v1/koreader/copies?${query}`)
    if (!current(id)) return
    copies.value = page.items
    copyCursor.value = page.nextCursor
    copyPolicies.value = Object.fromEntries(page.items.map((copy) => [copy.id, copy.policyOverride ?? '']))
  }
  async function loadDevices(id: number, cursor?: string) {
    const query = new URLSearchParams({ limit: '50' })
    if (cursor) query.set('cursor', cursor)
    const page = await request<KoreaderDeliveryDevicePage>(`/api/v1/koreader/copies/devices?${query}`)
    if (!current(id)) return
    devices.value = page.items
    deviceCursor.value = page.nextCursor
    devicePolicies.value = Object.fromEntries(page.items.map((device) => [device.deviceId, device.policy]))
  }
  const refresh = () =>
    perform(async (id) => {
      await Promise.all([loadCopies(id), toValue(bookFileId) === undefined ? loadDevices(id) : Promise.resolve()])
    })
  const nextCopies = () => perform((id) => loadCopies(id, copyCursor.value ?? undefined))
  const nextDevices = () => perform((id) => loadDevices(id, deviceCursor.value ?? undefined))
  const filterCopies = () => perform((id) => loadCopies(id))
  const supportsAutomatic = (target: KoreaderInstalledCopy | KoreaderDeliveryDevice) =>
    canDownload.value && target.deliveryCapabilityVersion >= 1 && target.positionCapabilityVersion >= 1
  async function saveCopy(copy: KoreaderInstalledCopy) {
    const policy = copyPolicies.value[copy.id] || null
    if (policy === 'automatic' && !supportsAutomatic(copy)) return
    await perform(async (id) => {
      await request(`/api/v1/koreader/copies/${copy.id}/policy`, { version: copy.policyVersion, policy } satisfies KoreaderCopyPolicyUpdate)
      if (current(id)) await loadCopies(id)
    })
  }
  async function saveDevice(device: KoreaderDeliveryDevice) {
    const policy = devicePolicies.value[device.deviceId]
    if (!policy || (policy === 'automatic' && !supportsAutomatic(device))) return
    await perform(async (id) => {
      await request(`/api/v1/koreader/copies/devices/${encodeURIComponent(device.deviceId)}/policy`, {
        version: device.policyVersion,
        policy,
      } satisfies KoreaderDevicePolicyUpdate)
      if (current(id)) await Promise.all([loadDevices(id), loadCopies(id)])
    })
  }
  watch(
    () => [toValue(bookFileId), permitted.value],
    () => {
      generation++
      copies.value = []
      devices.value = []
      copyPolicies.value = {}
      devicePolicies.value = {}
      copyCursor.value = null
      deviceCursor.value = null
      deviceId.value = ''
      error.value = ''
      busy.value = false
      void refresh()
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    disposed = true
    generation++
  })
  return {
    permitted,
    copies,
    devices,
    copyCursor,
    deviceCursor,
    deviceId,
    busy,
    error,
    copyPolicies,
    devicePolicies,
    refresh,
    nextCopies,
    nextDevices,
    filterCopies,
    supportsAutomatic,
    saveCopy,
    saveDevice,
  }
}

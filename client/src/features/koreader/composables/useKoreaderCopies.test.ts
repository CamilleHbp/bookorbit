import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Permission, type KoreaderDeliveryDevice, type KoreaderInstalledCopy } from '@bookorbit/types'
import { api } from '@/lib/api'
import { useKoreaderCopies } from './useKoreaderCopies'

const permissions = vi.hoisted(() => ({ sync: true, download: true }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => (permission === Permission.KoreaderSync ? permissions.sync : permissions.download),
  }),
}))
vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const mockApi = vi.mocked(api)
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response
const copy: KoreaderInstalledCopy = {
  id: 'ac5c5c54-f77c-4c17-881b-bfd79525bcd3',
  copyId: 'd292dc18-a1da-4670-8b3f-d7a328760bdf',
  deviceId: 'Kobo / bedroom',
  bookId: 3,
  bookFileId: 7,
  pathname: '/books/story.epub',
  sha256: 'a'.repeat(64),
  sizeBytes: 100,
  revisionId: null,
  currentRevisionId: null,
  currentSha256: 'b'.repeat(64),
  identity: 'provisional',
  policy: 'notify',
  policyOverride: null,
  policyVersion: 3,
  effectivePolicyVersion: '2:3',
  policyAcknowledged: false,
  lastContactAt: '2026-09-01T12:00:00Z',
  deliveryCapabilityVersion: 1,
  positionCapabilityVersion: 1,
}
const device: KoreaderDeliveryDevice = {
  deviceId: copy.deviceId,
  pluginVersion: '1.5.2',
  policy: 'notify',
  policyVersion: 2,
  deliveryCapabilityVersion: 1,
  positionCapabilityVersion: 1,
  lastContactAt: copy.lastContactAt,
}
describe('KOReader copy controls', () => {
  let scope: ReturnType<typeof effectScope>
  beforeEach(() => {
    permissions.sync = true
    permissions.download = true
    vi.clearAllMocks()
    scope = effectScope()
    mockApi.mockImplementation((url) => Promise.resolve(response({ items: String(url).includes('/devices?') ? [device] : [copy], nextCursor: null })))
  })
  afterEach(() => scope.stop())
  async function flush() {
    for (let i = 0; i < 12; i++) await Promise.resolve()
    await nextTick()
  }
  it('does not fetch inventory without synchronization permission', async () => {
    permissions.sync = false
    const model = scope.run(() => useKoreaderCopies(undefined))!
    await flush()
    await model.refresh()
    expect(mockApi).not.toHaveBeenCalled()
    expect(model.permitted.value).toBe(false)
  })
  it('filters books on the server and replaces bounded pages, including empty filtered pages', async () => {
    mockApi.mockResolvedValueOnce(response({ items: [], nextCursor: copy.id }))
    const model = scope.run(() => useKoreaderCopies(7))!
    await flush()
    expect(mockApi.mock.calls.map(([url]) => url)).toEqual(['/api/v1/koreader/copies?limit=50&bookFileId=7'])
    expect(model.copyCursor.value).toBe(copy.id)
    await model.nextCopies()
    expect(mockApi.mock.calls.at(-1)?.[0]).toBe(`/api/v1/koreader/copies?limit=50&cursor=${copy.id}&bookFileId=7`)
    expect(model.copies.value).toEqual([copy])
    mockApi.mockResolvedValueOnce(response({ items: [], nextCursor: null }))
    await model.refresh()
    expect(model.copies.value).toEqual([])
  })
  it('sends exact versioned policy DTOs and explicit null to restore inheritance', async () => {
    const model = scope.run(() => useKoreaderCopies(undefined))!
    await flush()
    model.copyPolicies.value[copy.id] = ''
    await model.saveCopy(copy)
    model.devicePolicies.value[device.deviceId] = 'ignore'
    await model.saveDevice(device)
    const patches = mockApi.mock.calls.filter(([, options]) => options?.method === 'PATCH')
    expect(patches.map(([url, options]) => [url, JSON.parse(options!.body as string)])).toEqual([
      [`/api/v1/koreader/copies/${copy.id}/policy`, { version: 3, policy: null }],
      ['/api/v1/koreader/copies/devices/Kobo%20%2F%20bedroom/policy', { version: 2, policy: 'ignore' }],
    ])
  })
  it('requires download permission and independent delivery and restoration capabilities for Automatic', async () => {
    permissions.download = false
    const model = scope.run(() => useKoreaderCopies(7))!
    await flush()
    model.copyPolicies.value[copy.id] = 'automatic'
    await model.saveCopy(copy)
    expect(mockApi.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toEqual([])
    expect(model.supportsAutomatic(copy)).toBe(false)
    expect(model.supportsAutomatic({ ...copy, deliveryCapabilityVersion: 0 })).toBe(false)
    expect(model.supportsAutomatic({ ...copy, positionCapabilityVersion: 0 })).toBe(false)
  })
  it('does not treat either advertised capability as a substitute for the other', async () => {
    const model = scope.run(() => useKoreaderCopies(7))!
    await flush()
    expect(model.supportsAutomatic(copy)).toBe(true)
    expect(model.supportsAutomatic({ ...copy, deliveryCapabilityVersion: 0 })).toBe(false)
    expect(model.supportsAutomatic({ ...copy, positionCapabilityVersion: 0 })).toBe(false)
  })
  it('discards late responses when switching files', async () => {
    let resolve!: (response: Response) => void
    mockApi.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const fileId = ref(7)
    const model = scope.run(() => useKoreaderCopies(fileId))!
    fileId.value = 8
    mockApi.mockResolvedValueOnce(response({ items: [{ ...copy, bookFileId: 8 }], nextCursor: null }))
    await flush()
    resolve(response({ items: [copy], nextCursor: copy.id }))
    await flush()
    expect(model.copies.value[0]?.bookFileId).toBe(8)
    expect(model.copyCursor.value).toBeNull()
    expect(model.busy.value).toBe(false)
  })
  it('keeps conflicting policy edits visible until an explicit refresh', async () => {
    const model = scope.run(() => useKoreaderCopies(7))!
    await flush()
    mockApi.mockResolvedValueOnce(response({ message: 'Policy changed on another device' }, 409))
    model.copyPolicies.value[copy.id] = 'ignore'
    await model.saveCopy(copy)
    expect(model.error.value).toBe('Policy changed on another device')
    expect(model.copyPolicies.value[copy.id]).toBe('ignore')
    expect(model.copies.value[0]?.policy).toBe('notify')
    await model.refresh()
    expect(model.error.value).toBe('')
  })
})

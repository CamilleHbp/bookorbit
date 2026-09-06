import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Permission, type KoreaderDeliveryJob, type KoreaderInstalledCopy } from '@bookorbit/types'
import { api } from '@/lib/api'
import { useKoreaderDelivery } from './useKoreaderDelivery'

const permissions = vi.hoisted(() => ({ sync: true, download: true }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => (permission === Permission.KoreaderSync ? permissions.sync : permissions.download),
  }),
}))
vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const mockApi = vi.mocked(api)
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response
const copy = {
  id: 'copy',
  currentRevisionId: 'revision',
  currentSha256: 'b'.repeat(64),
  sha256: 'a'.repeat(64),
  deliveryCapabilityVersion: 1,
  positionCapabilityVersion: 1,
} as KoreaderInstalledCopy
const job = {
  id: 'job',
  installedCopyId: copy.id,
  revisionId: 'revision',
  installationState: 'requested',
  restorationState: 'verification_pending',
  version: 2,
  cancelledAt: null,
  failureCode: null,
} as KoreaderDeliveryJob
describe('device delivery controls', () => {
  let scope: ReturnType<typeof effectScope>
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    permissions.sync = true
    permissions.download = true
    scope = effectScope()
    mockApi.mockResolvedValue(response({ items: [job], nextCursor: null }))
  })
  afterEach(() => {
    scope.stop()
    vi.useRealTimers()
  })
  async function flush() {
    for (let i = 0; i < 12; i++) await Promise.resolve()
    await nextTick()
  }
  it('recovers durable jobs on opening and polls the current bounded page', async () => {
    const model = scope.run(() => useKoreaderDelivery(copy))!
    await flush()
    expect(mockApi.mock.calls[0]?.[0]).toBe('/api/v1/koreader/deliveries?installedCopyId=copy&limit=25')
    expect(model.jobs.value).toEqual([job])
    mockApi.mockResolvedValueOnce(response({ items: [], nextCursor: 'older' }))
    await model.refresh()
    await model.nextPage()
    expect(mockApi.mock.calls.at(-1)?.[0]).toContain('cursor=older')
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockApi.mock.calls.at(-1)?.[0]).toContain('cursor=older')
  })
  it('reuses the exact request identity after an uncertain response and binds delivery to the expected revision', async () => {
    const model = scope.run(() => useKoreaderDelivery(copy))!
    await flush()
    mockApi.mockRejectedValueOnce(new Error('Connection lost'))
    await model.requestDelivery()
    const first = mockApi.mock.calls.at(-1)!
    mockApi.mockResolvedValueOnce(response(job, 202))
    await model.requestDelivery()
    const posts = mockApi.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[1]?.[0]).toBe('/api/v1/koreader/deliveries/copies/copy')
    expect(posts[1]?.[1]?.body).toBe(first[1]?.body)
    expect(JSON.parse(posts[1]![1]!.body as string)).toEqual({ idempotencyKey: expect.any(String), expectedRevisionId: 'revision' })
  })
  it('keeps cancellation and retry explicit with versioned bodies', async () => {
    const model = scope.run(() => useKoreaderDelivery(copy))!
    await flush()
    const cancelled = { ...job, version: 3, cancelledAt: '2026-09-06T12:00:00Z' }
    mockApi.mockResolvedValueOnce(response(cancelled, 202))
    await model.cancel(job)
    expect(model.jobs.value[0]?.cancelledAt).toBe(cancelled.cancelledAt)
    expect(model.canRetry(cancelled)).toBe(true)
    mockApi.mockResolvedValueOnce(response({ ...job, version: 4 }, 202))
    await model.retry(cancelled)
    expect(
      mockApi.mock.calls.filter(([, options]) => options?.method === 'POST').map(([url, options]) => [url, JSON.parse(options!.body as string)]),
    ).toEqual([
      ['/api/v1/koreader/deliveries/job/cancel', { version: 2 }],
      ['/api/v1/koreader/deliveries/job/retry', { version: 3 }],
    ])
  })
  it('does not confuse installation with restoration or retry completed installations', async () => {
    const installed = { ...job, installationState: 'installed' as const, restorationState: 'verification_pending' as const }
    mockApi.mockResolvedValue(response({ items: [installed], nextCursor: null }))
    const model = scope.run(() => useKoreaderDelivery(copy))!
    await flush()
    expect(model.jobs.value[0]?.restorationState).toBe('verification_pending')
    expect(model.canCancel(installed)).toBe(false)
    expect(model.canRetry(installed)).toBe(false)
  })
  it('blocks unauthorized or unsupported file delivery', async () => {
    permissions.download = false
    const model = scope.run(() => useKoreaderDelivery(copy))!
    await flush()
    await model.requestDelivery()
    expect(model.canRequest.value).toBe(false)
    expect(mockApi.mock.calls.filter(([, options]) => options?.method === 'POST')).toEqual([])
    const unsupported = scope.run(() => useKoreaderDelivery({ ...copy, positionCapabilityVersion: 0 }))!
    await flush()
    expect(unsupported.supported.value).toBe(false)
  })
  it('recovers polling after failures and discards old copy responses', async () => {
    mockApi.mockRejectedValueOnce(new Error('Network unavailable'))
    const selected = ref(copy)
    const model = scope.run(() => useKoreaderDelivery(selected))!
    await flush()
    expect(model.error.value).toBe('Network unavailable')
    await vi.advanceTimersByTimeAsync(5000)
    expect(model.error.value).toBe('')
    let resolve!: (value: Response) => void
    mockApi.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const old = model.refresh()
    selected.value = { ...copy, id: 'other' }
    mockApi.mockResolvedValueOnce(response({ items: [], nextCursor: null }))
    await flush()
    resolve(response({ items: [job], nextCursor: 'old' }))
    await old
    await flush()
    expect(model.jobs.value).toEqual([])
    expect(model.nextCursor.value).toBeNull()
    scope.stop()
    const count = mockApi.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockApi).toHaveBeenCalledTimes(count)
  })
})

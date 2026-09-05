import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFanfictionSettings } from './useFanfictionSettings'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))
const mockApi = vi.mocked(api)
const response = (value: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => value }) as Response

describe('Fanfiction settings API contract', () => {
  let scope: ReturnType<typeof effectScope>
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    scope = effectScope()
  })
  afterEach(() => {
    scope.stop()
    vi.useRealTimers()
  })
  function settings() {
    return scope.run(() => useFanfictionSettings())!
  }
  it('loads only administrable libraries and bounded profile/activity pages', async () => {
    mockApi.mockImplementation(async (path) => {
      if (String(path).startsWith('/api/v1/fanfiction/libraries')) return response({ items: [{ id: 5, name: 'Stories' }], nextCursor: null })
      if (String(path).endsWith('/runtime')) return response({ version: '4.61.0', protocolVersion: 1, ready: true })
      return response({ items: [], nextCursor: null })
    })
    const state = settings()
    await state.loadLibraries()
    expect(state.libraryId.value).toBe(5)
    expect(state.health.value?.ready).toBe(true)
    expect(mockApi.mock.calls.map((call) => call[0])).toContain('/api/v1/libraries/5/fanfiction/profiles?limit=50')
    expect(mockApi.mock.calls.map((call) => call[0])).toContain('/api/v1/libraries/5/fanfiction/jobs?limit=50')
  })
  it('sends only profile DTO fields and omits unchanged credentials', async () => {
    const state = settings()
    state.libraryId.value = 5
    state.newProfile()
    state.name.value = 'AO3'
    state.configuration.value = '[defaults]\ninclude_images: true\n'
    mockApi.mockResolvedValue(response({ items: [], nextCursor: null }))
    await state.saveProfile()
    const [url, options] = mockApi.mock.calls[0]!
    expect(url).toBe('/api/v1/libraries/5/fanfiction/profiles')
    expect(JSON.parse(options!.body as string)).toEqual({ name: 'AO3', configuration: '[defaults]\ninclude_images: true\n' })
    expect(options!.method).toBe('POST')
  })
  it('reuses the durable request identity after an uncertain preview response', async () => {
    const state = settings()
    state.libraryId.value = 5
    state.previewUrl.value = 'https://archiveofourown.org/works/123'
    mockApi.mockRejectedValueOnce(new Error('connection interrupted')).mockResolvedValueOnce(response({ id: 'job', state: 'queued' }))
    await state.preview()
    await state.preview()
    const first = JSON.parse(mockApi.mock.calls[0]![1]!.body as string)
    const second = JSON.parse(mockApi.mock.calls[1]![1]!.body as string)
    expect(first).toEqual(second)
    expect(first).toEqual({ url: state.previewUrl.value, idempotencyKey: expect.any(String) })
    expect(state.jobs.value[0]?.id).toBe('job')
  })
})

import { effectScope, nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useFanfictionBatchScope } from './useFanfictionBatchScope'
vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const mockApi = vi.mocked(api)
const response = (total: number) => new Response(JSON.stringify({ total, matching: total }))
let scope: ReturnType<typeof effectScope>
afterEach(() => {
  scope.stop()
  vi.clearAllMocks()
})
describe('library check scope', () => {
  it('discards counts from the previous library when requests finish out of order', async () => {
    const library = ref<number | null>(5)
    let release!: (value: Response) => void
    mockApi
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      .mockResolvedValueOnce(response(4))
    scope = effectScope()
    const state = scope.run(() => useFanfictionBatchScope(library, ref(''), ref('')))!
    const signal = mockApi.mock.calls[0]![1]!.signal
    library.value = 6
    await nextTick()
    await flushPromises()
    expect(signal?.aborted).toBe(true)
    release(response(200))
    await flushPromises()
    expect(state.counts.value?.total).toBe(4)
  })
  it('keeps an unknown count distinct from an empty library and supports retry', async () => {
    mockApi.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(response(0))
    scope = effectScope()
    const state = scope.run(() => useFanfictionBatchScope(ref(5), ref(''), ref('')))!
    await flushPromises()
    expect(state.error.value).toBe(true)
    expect(state.counts.value).toBeNull()
    await state.reload()
    expect(state.counts.value?.total).toBe(0)
    expect(state.error.value).toBe(false)
  })
})

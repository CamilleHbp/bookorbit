import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBookRevisions } from '../useBookRevisions'

const api = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>())
vi.mock('@/lib/api', () => ({ api }))
beforeEach(() => {
  vi.resetAllMocks()
})
const cursor = '95f66679-bff3-4f7e-a8c6-1d4cf246700a'
function response(items: unknown[], nextCursor: string | null = null) {
  return { ok: true, json: async () => ({ items, nextCursor }) }
}
function setup() {
  const fileId = ref(9)
  let history!: ReturnType<typeof useBookRevisions>
  const wrapper = mount(
    defineComponent({
      setup() {
        history = useBookRevisions(7, fileId)
        return () => null
      },
    }),
  )
  return { history, wrapper, fileId }
}

describe('revision history requests', () => {
  it('loads lazily with bounded server pagination and retries the requested cursor', async () => {
    const { history, wrapper } = setup()
    expect(api).not.toHaveBeenCalled()
    api.mockResolvedValueOnce(response([{ revision: cursor }], cursor))
    history.toggle()
    await flushPromises()
    expect(api).toHaveBeenCalledWith('/api/v1/libraries/7/files/9/revisions?limit=25', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    api.mockResolvedValueOnce({ ok: false })
    history.older()
    await flushPromises()
    expect(history.failed.value).toBe(true)
    api.mockResolvedValueOnce(response([{ revision: 'older' }]))
    history.retry()
    await flushPromises()
    expect(api).toHaveBeenLastCalledWith(`/api/v1/libraries/7/files/9/revisions?limit=25&cursor=${cursor}`, expect.any(Object))
    expect(history.items.value).toEqual([{ revision: 'older' }])
    wrapper.unmount()
  })

  it('aborts stale requests when selecting another file and ignores late responses', async () => {
    const { history, wrapper, fileId } = setup()
    let complete!: (value: unknown) => void
    api.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    history.toggle()
    const signal = api.mock.calls[0]?.[1]?.signal as AbortSignal
    api.mockResolvedValueOnce(response([{ revision: 'new-file' }]))
    fileId.value = 10
    await flushPromises()
    expect(signal.aborted).toBe(true)
    complete(response([{ revision: 'old-file' }]))
    await flushPromises()
    expect(history.items.value).toEqual([{ revision: 'new-file' }])
    expect(api).toHaveBeenLastCalledWith('/api/v1/libraries/7/files/10/revisions?limit=25', expect.any(Object))
    wrapper.unmount()
  })
})

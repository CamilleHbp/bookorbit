import 'fake-indexeddb/auto'
import { defineComponent, h, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadingAnchor } from '@bookorbit/types'
import type { RelocateDetail } from '../../epub/composables/useFoliate'
import { api } from '@/lib/api'
import { readingEventOutbox } from './reading-event-outbox'
import { useReaderProgress } from './useReaderProgress'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const mockApi = vi.mocked(api)
describe('reader progress across offline close and reopen', () => {
  let wrapper: VueWrapper | undefined
  let progress: ReturnType<typeof useReaderProgress>
  const userId = ref<number | null>(7)
  const anchor: ReadingAnchor = {
    schemaVersion: 1,
    bookId: 2,
    bookFileId: 9,
    revision: '95f66679-bff3-4f7e-a8c6-1d4cf246700a',
    chapterIndex: 0,
    chapterFraction: 0.2,
    bookFraction: 0.1,
    quote: 'Saved passage',
  }
  const relocate = (restoration: boolean): RelocateDetail =>
    ({
      fraction: 0.1,
      cfi: 'epubcfi(/6/2)',
      readingAnchor: anchor,
      readingLibraryId: 5,
      readingResetGeneration: 2,
      restoration,
    }) as RelocateDetail
  function open() {
    wrapper = mount(
      defineComponent({
        setup() {
          progress = useReaderProgress(2, 9, ref(0), 0, { userId })
          return () => h('div')
        },
      }),
    )
  }
  beforeEach(() => {
    vi.clearAllMocks()
    userId.value = 7
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  })
  afterEach(async () => {
    wrapper?.unmount()
    wrapper = undefined
    await readingEventOutbox.close()
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('bookorbit-reading-events')
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
    vi.restoreAllMocks()
  })
  it('persists real reading before the network debounce and replays it before loading server progress', async () => {
    open()
    progress.onRelocate(relocate(true))
    expect(await readingEventOutbox.pending(7, 9)).toEqual([])
    progress.onRelocate(relocate(false))
    await vi.waitFor(async () => expect(await readingEventOutbox.pending(7, 9)).toHaveLength(1))
    const [saved] = await readingEventOutbox.pending(7, 9)
    wrapper!.unmount()
    wrapper = undefined
    await readingEventOutbox.close()
    expect(mockApi).not.toHaveBeenCalled()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    mockApi.mockImplementation((url) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            String(url).includes('/reading-events')
              ? { outcome: 'accepted', resetGeneration: 2, anchor: saved!.request.anchor }
              : { cfi: 'epubcfi(/6/2)', percentage: 10 },
          ),
          { status: 200 },
        ),
      ),
    )
    open()
    await progress.load()
    expect(mockApi.mock.calls.map(([url]) => url)).toEqual(['/api/v1/libraries/5/files/9/reading-events', '/api/v1/books/files/9/progress'])
    expect(JSON.parse(mockApi.mock.calls[0]![1]!.body as string)).toEqual(saved!.request)
    progress.onRelocate(relocate(true))
    await progress.save()
    expect(await readingEventOutbox.pending(7, 9)).toEqual([])
    expect(mockApi).toHaveBeenCalledTimes(2)
  })
  it('keeps captured reading owned by its original account while persistence is in flight', async () => {
    open()
    progress.onRelocate(relocate(false))
    userId.value = 8
    await vi.waitFor(async () => expect(await readingEventOutbox.pending(7, 9)).toHaveLength(1))
    await progress.save()
    expect(await readingEventOutbox.pending(8, 9)).toEqual([])
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('keeps online saving available when local storage fails and leaves the storage warning visible', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    vi.spyOn(readingEventOutbox, 'put').mockRejectedValue(new Error('Offline storage unavailable'))
    mockApi.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ outcome: 'accepted', resetGeneration: 2, anchor: null }), { status: 200 })),
    )
    open()
    progress.onRelocate(relocate(false))
    await progress.save()
    expect(mockApi).toHaveBeenCalledOnce()
    expect(mockApi.mock.calls[0]![0]).toBe('/api/v1/libraries/5/files/9/reading-events')
    expect(JSON.parse(mockApi.mock.calls[0]![1]!.body as string)).toMatchObject({ expectedUserId: 7, anchor: { quote: 'Saved passage' } })
    expect(progress.synchronizationError.value).toBe('Offline storage unavailable')
  })
})

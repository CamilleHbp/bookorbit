import { defineComponent, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FanfictionReviewScope } from '@bookorbit/types'
import { api } from '@/lib/api'
import { useStoryReviewQueue } from './useStoryReviewQueue'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const source = (id: number) => ({
  id: String(id),
  libraryId: 5,
  bookId: id,
  title: `Story ${id}`,
  site: 'example.org',
  canonicalUrl: `https://example.org/${id}`,
})
const values = { title: 'Title', description: '', authors: ['Author'], genres: ['Fantasy'], tags: ['Original'] }
const review = {
  jobId: 'job',
  review: {
    current: values,
    incoming: { ...values, tags: ['Incoming'] },
    fields: ['tags'],
    fingerprint: 'fingerprint',
    previousState: 'active',
    lockedFields: [],
  },
}

describe('story review queue', () => {
  let wrapper: ReturnType<typeof mount>
  let queue: ReturnType<typeof useStoryReviewQueue>
  const libraryId = ref(5)
  const scope = ref<FanfictionReviewScope>('pending')
  async function open() {
    wrapper = mount(
      defineComponent({
        setup() {
          queue = useStoryReviewQueue(libraryId, scope)
          return () => null
        },
      }),
    )
    await flushPromises()
  }
  beforeEach(() => {
    libraryId.value = 5
    scope.value = 'pending'
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (options?.method === 'POST' || options?.method === 'PATCH') return respond({ resolved: true })
      if (String(path).includes('/sources?')) return respond({ items: [source(1), source(2)], nextCursor: null })
      if (String(path).endsWith('/metadata-review')) return respond(review)
      return respond({ ...values, authors: [{ name: 'Author' }], lockedFields: [] })
    })
  })
  afterEach(() => {
    wrapper?.unmount()
    vi.restoreAllMocks()
  })

  it('starts with library tags even when a website proposes other tags', async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (String(path).includes('/sources?')) return respond({ items: [source(1)], nextCursor: null })
      return respond({ ...review, review: { ...review.review, tags: { custom: ['Original'], managed: [], added: ['Incoming'], removed: [] } } })
    })
    await open()
    expect(queue.current.value?.choices.tags).toBe('keep')
    expect(queue.current.value?.choices.values?.tags).toEqual(['Original'])
  })

  it('skips and goes back without writes, retaining edits and queue membership', async () => {
    await open()
    queue.current.value!.choices.tags = 'select'
    queue.current.value!.choices.selectedTags = ['Edited']
    await queue.next()
    expect(queue.current.value?.source.id).toBe('2')
    await queue.previous()
    expect(queue.current.value?.choices.selectedTags).toEqual(['Edited'])
    expect(queue.skippedCount.value).toBe(1)
    expect(queue.hasDrafts.value).toBe(true)
    expect(vi.mocked(api).mock.calls.some(([, options]) => options?.method)).toBe(false)
  })

  it('saves the exact review before advancing and does not resubmit on previous', async () => {
    await open()
    await queue.save()
    expect(queue.current.value?.source.id).toBe('2')
    expect(queue.savedCount.value).toBe(1)
    const write = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'POST')!
    expect(write[0]).toBe('/api/v1/libraries/5/fanfiction/sources/1/metadata-review')
    expect(JSON.parse(write[1]!.body as string)).toMatchObject({ jobId: 'job', fingerprint: 'fingerprint', tags: 'keep' })
    await queue.previous()
    expect(queue.current.value?.saved).toBe(true)
    await queue.save()
    expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method)).toHaveLength(1)
    expect(queue.savedCount.value).toBe(1)
  })

  it('keeps the story and draft after a failed save and allows a later retry', async () => {
    await open()
    queue.current.value!.choices.tags = 'merge'
    vi.mocked(api).mockResolvedValueOnce(respond({ message: 'Book details changed. Refresh the review.' }, 409))
    await queue.save()
    expect(queue.current.value?.source.id).toBe('1')
    expect(queue.current.value?.choices.tags).toBe('merge')
    expect(queue.error.value).toContain('Book details changed')
    expect(queue.savedCount.value).toBe(0)
    await queue.save()
    expect(queue.current.value?.source.id).toBe('2')
  })

  it('continues through server cursors even when saving removes a pending story', async () => {
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (options?.method) return respond({ resolved: true })
      if (String(path).includes('/sources?'))
        return respond(String(path).includes('cursor=1') ? { items: [source(2)], nextCursor: null } : { items: [source(1)], nextCursor: '1' })
      return respond(review)
    })
    await open()
    await queue.save()
    expect(queue.current.value?.source.id).toBe('2')
    expect(vi.mocked(api).mock.calls.some(([path]) => String(path).includes('reviewScope=pending&limit=25&cursor=1'))).toBe(true)
    await queue.next()
    expect(queue.finished.value).toBe(true)
    expect(queue.skippedCount.value).toBe(1)
    await queue.previous()
    expect(queue.current.value?.source.id).toBe('2')
  })

  it('does not repeat a successful save when loading the next page fails', async () => {
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (options?.method) return respond({ resolved: true })
      if (String(path).includes('cursor=')) return respond({ message: 'Try again' }, 503)
      if (String(path).includes('/sources?')) return respond({ items: [source(1)], nextCursor: '1' })
      return respond(review)
    })
    await open()
    await queue.save()
    expect(queue.current.value?.saved).toBe(true)
    await queue.save()
    expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method)).toHaveLength(1)
  })

  it('edits non-pending stories through book metadata and omits locked and unchanged fields', async () => {
    scope.value = 'all'
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (options?.method) return respond({})
      if (String(path).includes('/sources?')) return respond({ items: [source(1)], nextCursor: null })
      if (String(path).endsWith('/metadata-review')) return respond(null)
      return respond({ ...values, authors: [{ name: 'Author' }], lockedFields: ['title'] })
    })
    await open()
    queue.current.value!.values.title = 'Locked change'
    queue.current.value!.values.tags = ['Custom']
    await queue.save()
    const write = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'PATCH')!
    expect(write[0]).toBe('/api/v1/books/1/metadata')
    expect(JSON.parse(write[1]!.body as string)).toEqual({ tags: ['Custom'] })
    expect(queue.finished.value).toBe(true)
  })

  it('guards unsaved drafts but does not warn for untouched reviews', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await open()
    expect(queue.confirmLeave()).toBe(true)
    queue.current.value!.choices.tags = 'merge'
    expect(queue.confirmLeave()).toBe(false)
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('ignores stale responses after the library changes and resets progress', async () => {
    await open()
    await queue.save()
    libraryId.value = 6
    await flushPromises()
    expect(queue.savedCount.value).toBe(0)
    expect(queue.position.value).toBe(1)
    expect(vi.mocked(api).mock.calls.some(([path]) => String(path).includes('/libraries/6/'))).toBe(true)
  })
})

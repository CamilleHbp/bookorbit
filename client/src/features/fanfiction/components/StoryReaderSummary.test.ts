import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import StoryReaderSummary from './StoryReaderSummary.vue'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => true }) }))

describe('reader story linking', () => {
  it('reloads the linked story and replaces the linking panel with reading controls', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(null) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ canonicalUrl: 'https://example.com/story', storyStatus: 'ongoing', chapterCount: 4, reading: {} }),
      } as Response)
    const wrapper = mount(StoryReaderSummary, {
      props: { bookId: 7, bookFileId: 9, libraryId: 5 },
      global: { stubs: { LinkStorySource: true, StoryReadingActions: true, StoryCategories: true, KoreaderCopiesPanel: true } },
    })
    await flushPromises()
    wrapper.findComponent({ name: 'LinkStorySource' }).vm.$emit('linked')
    await flushPromises()
    expect(api).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api).mock.calls[1]![0]).toBe('/api/v1/books/7/files/9/story')
    expect(wrapper.findComponent({ name: 'LinkStorySource' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'StoryReadingActions' }).exists()).toBe(true)
    expect(wrapper.find('a').attributes('href')).toBe('https://example.com/story')
    wrapper.unmount()
  })
})

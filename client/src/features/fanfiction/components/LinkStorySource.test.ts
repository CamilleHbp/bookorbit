import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import LinkStorySource from './LinkStorySource.vue'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const mockApi = vi.mocked(api)
const response = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) }) as Response
const preview = {
  id: 'candidate',
  title: 'Local',
  authors: [],
  chapterCount: 1,
  canonicalUrl: 'https://example.com/story/1',
  remote: { title: 'Remote', authors: [], chapterCount: 2 },
}

describe('website access during direct linking', () => {
  let wrapper: ReturnType<typeof mount>
  beforeEach(() => {
    vi.clearAllMocks()
    wrapper = mount(LinkStorySource, { props: { bookId: 1, bookFileId: 2, libraryId: 3 }, global: { stubs: { RouterLink: true } } })
  })
  afterEach(() => wrapper.unmount())
  it('uses the original URL for inspection and links with daily updates', async () => {
    mockApi.mockResolvedValueOnce(response(preview)).mockResolvedValueOnce(response({ id: 'job', state: 'queued' }))
    await wrapper.find('input[type="url"]').setValue('https://example.com/story/1')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(JSON.parse(mockApi.mock.calls[0]![1]!.body as string)).toEqual({ bookId: 1, bookFileId: 2, url: preview.canonicalUrl })
    await wrapper.findAll('form')[1]!.trigger('submit')
    await flushPromises()
    expect(JSON.parse(mockApi.mock.calls[1]![1]!.body as string)).toMatchObject({ canonicalUrl: preview.canonicalUrl, intervalMinutes: 1440 })
  })
  it('uses public access when the website has no saved login', async () => {
    mockApi.mockResolvedValueOnce(response(preview))
    await wrapper.find('input[type="url"]').setValue('https://example.com/story/1')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(mockApi).toHaveBeenCalledTimes(1)
    expect(String(mockApi.mock.calls[0]![0])).toContain('/discovery/book')
    expect(JSON.parse(mockApi.mock.calls[0]![1]!.body as string)).not.toHaveProperty('profileId')
  })
  it('keeps identity errors actionable without asking for a profile', async () => {
    mockApi.mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'This URL does not match the saved story' }) } as Response)
    await wrapper.find('input[type="url"]').setValue('https://example.com/story/1')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('does not match')
    expect(wrapper.findAll('form')).toHaveLength(1)
    expect(mockApi).toHaveBeenCalledOnce()
  })
})

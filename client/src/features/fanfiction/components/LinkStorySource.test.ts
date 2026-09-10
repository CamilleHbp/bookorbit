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

describe('profile matching during direct linking', () => {
  let wrapper: ReturnType<typeof mount>
  beforeEach(() => {
    vi.clearAllMocks()
    wrapper = mount(LinkStorySource, { props: { bookId: 1, bookFileId: 2, libraryId: 3 }, global: { stubs: { RouterLink: true } } })
  })
  afterEach(() => wrapper.unmount())
  it('uses the suggested profile for both inspection and linking', async () => {
    mockApi
      .mockResolvedValueOnce(response({ profile: { id: 'matched', name: 'Matched profile' } }))
      .mockResolvedValueOnce(response(preview))
      .mockResolvedValueOnce(response({ id: 'job', state: 'queued' }))
    await wrapper.find('input[type="url"]').setValue('https://example.com/story/1')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('Matched profile')
    expect(JSON.parse(mockApi.mock.calls[1]![1]!.body as string)).toMatchObject({ profileId: 'matched' })
    await wrapper.findAll('form')[1]!.trigger('submit')
    await flushPromises()
    expect(JSON.parse(mockApi.mock.calls[2]![1]!.body as string)).toMatchObject({ profileId: 'matched' })
  })
  it('allows public access to override automatic matching', async () => {
    mockApi.mockResolvedValueOnce(response(preview))
    await wrapper.find('select').setValue('public')
    await wrapper.find('input[type="url"]').setValue('https://example.com/story/1')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(mockApi).toHaveBeenCalledOnce()
    expect(String(mockApi.mock.calls[0]![0])).toContain('/discovery/book')
    expect(JSON.parse(mockApi.mock.calls[0]![1]!.body as string)).not.toHaveProperty('profileId')
  })
  it('asks for an explicit choice when matching is ambiguous', async () => {
    mockApi.mockResolvedValueOnce(response({ profile: null, ambiguous: true }))
    await wrapper.find('input[type="url"]').setValue('https://example.com/story/1')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('More than one profile')
    expect(wrapper.findAll('form')).toHaveLength(1)
    expect(mockApi).toHaveBeenCalledOnce()
  })
})

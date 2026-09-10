import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import ExistingStories from './ExistingStories.vue'
import { discoveryReviewFixture } from '../composables/discoveryReviewFixture'
vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
let wrapper: ReturnType<typeof mount>
afterEach(() => {
  wrapper?.unmount()
  vi.clearAllMocks()
})
describe('website review interface', () => {
  it('shows collapsible complete website groups and local/remote identity', async () => {
    vi.mocked(api).mockImplementation(discoveryReviewFixture().fetch)
    wrapper = mount(ExistingStories, {
      props: { libraryId: 1, profiles: [], profileCursor: null },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })
    await flushPromises()
    const headers = wrapper.findAll('h3 button')
    expect(headers.map((button) => button.attributes('aria-expanded'))).toEqual(['false', 'false'])
    expect(headers[1]!.text()).toContain('23 stories to review')
    await headers[1]!.trigger('click')
    await flushPromises()
    expect(headers[1]!.attributes('aria-expanded')).toBe('true')
    const group = wrapper.find('section[aria-label="royalroad.com"]')
    for (const text of ['Select all 23 stories', 'In BookOrbit', 'On the website', 'A different title', 'Title or author differs'])
      expect(group.text()).toContain(text)
    expect(group.find('a[target="_blank"]').attributes('href')).toContain('royalroad.com')
    await headers[1]!.trigger('click')
    expect(headers[1]!.attributes('aria-expanded')).toBe('false')
  })
})

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import ExistingStories from './ExistingStories.vue'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const mockApi = vi.mocked(api)
const book = (id: string, site: string, ambiguous = false) => ({
  id,
  title: `Story ${id}`,
  bookId: 1,
  authors: [],
  chapterCount: 2,
  state: 'pending',
  urls: [{ url: `https://${site}/1`, recognized: true, canonicalUrl: `https://${site}/1`, site }],
  profileMatch: { profile: null, ambiguous },
})
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
let wrapper: ReturnType<typeof mount>
afterEach(() => {
  wrapper?.unmount()
  vi.clearAllMocks()
})
async function open() {
  mockApi.mockImplementation(async (path) =>
    response(
      String(path).includes('/jobs')
        ? { items: [] }
        : { items: [book('a', 'www.royalroad.com'), book('b', 'archiveofourown.org'), book('c', 'royalroad.com', true)], total: 3, nextCursor: null },
    ),
  )
  wrapper = mount(ExistingStories, {
    props: { libraryId: 1, profiles: [], profileCursor: null, profileId: '', schedule: 'manual' },
    global: { stubs: { RouterLink: true } },
  })
  await flushPromises()
}
describe('website review', () => {
  it('groups websites, preselects confident matches, and shows accurate linking counts', async () => {
    await open()
    expect(wrapper.findAll('h3').map((heading) => heading.text())).toEqual(['archiveofourown.org', 'royalroad.com'])
    expect(wrapper.find('input[aria-label="Select Story a"]').element).toHaveProperty('checked', true)
    expect(wrapper.find('input[aria-label="Select Story b"]').element).toHaveProperty('checked', true)
    expect(wrapper.find('input[aria-label="Select Story c"]').element).toHaveProperty('checked', false)
    expect(wrapper.text()).toContain('Link 2 books')
    const group = wrapper.find('section[aria-label="royalroad.com"]')
    await group
      .findAll('button')
      .find((button) => button.text() === 'Link 1 book')!
      .trigger('click')
    await flushPromises()
    const call = mockApi.mock.calls.find(([path]) => String(path).endsWith('/selection'))!
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ ids: ['a'], autoProfile: true })
  })
  it('includes an explicit per-book profile choice in the main batch', async () => {
    await open()
    const exception = wrapper.findAll('article').find((article) => article.find('input[aria-label="Select Story c"]').exists())!
    await exception.find('select').setValue('public')
    await exception.find('input[type="checkbox"]').setValue(true)
    expect(wrapper.text()).toContain('Link 3 books')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Link 3 books')!
      .trigger('click')
    await flushPromises()
    const call = mockApi.mock.calls.find(([path]) => String(path).endsWith('/selection'))!
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ ids: ['a', 'b', 'c'], overrides: [{ id: 'c', profileId: null }] })
  })
  it('filters a chosen profile automatically and keeps the website filter for public access', async () => {
    await open()
    await wrapper.setProps({
      profiles: [{ id: 'profile', name: 'My website', libraryId: 1, rootUrls: ['https://royalroad.com'], version: 1, updatedAt: '' }],
    })
    await wrapper.findAll('select')[1]!.setValue('profile')
    await flushPromises()
    const requests = mockApi.mock.calls.filter(([path]) => String(path).includes('/discovery?'))
    expect(new URL(String(requests.at(-1)![0]), 'https://local').searchParams.get('urlPrefixes')).toBe('https://royalroad.com')
    mockApi.mockClear()
    await wrapper.findAll('select')[1]!.setValue('public')
    await flushPromises()
    expect(mockApi).not.toHaveBeenCalled()
    expect(wrapper.find('textarea').element).toHaveProperty('value', 'https://royalroad.com')
  })
})

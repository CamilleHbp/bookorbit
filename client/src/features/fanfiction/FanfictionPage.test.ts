import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import FanfictionPage from './FanfictionPage.vue'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => true }) }))

describe('Fanfiction navigation and story hierarchy', () => {
  let wrapper: ReturnType<typeof mount> | undefined
  beforeEach(() => {
    vi.mocked(api).mockImplementation(async (url) => {
      const path = String(url)
      const items = path.startsWith('/api/v1/fanfiction/libraries')
        ? [{ id: 5, name: 'Stories' }]
        : path.includes('/sources/folders')
          ? [{ id: 8, path: 'Stories' }]
          : []
      return new Response(JSON.stringify({ items, nextCursor: null }), { status: 200 })
    })
  })
  afterEach(() => {
    wrapper?.unmount()
    vi.clearAllMocks()
  })

  async function open(path = '/fanfiction') {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/fanfiction', name: 'fanfiction', component: FanfictionPage },
        { path: '/settings', name: 'settings-fanfiction', component: { template: '<div />' } },
        { path: '/book/:bookId', name: 'book-detail', component: { template: '<div />' } },
      ],
    })
    await router.push(path)
    await router.isReady()
    wrapper = mount(FanfictionPage, {
      global: {
        plugins: [router],
        stubs: { DialogPortal: { template: '<div><slot /></div>' }, SourceProfileEditor: true, SourceProfiles: true, ExistingStories: true },
      },
    })
    await flushPromises()
    return router
  }

  it('shows one duplicate at a time with Next and Previous controls', async () => {
    await open('/fanfiction?tab=add')
    vi.mocked(api).mockImplementation(async (url, options) => {
      if (String(url).includes('profile-match')) return new Response(JSON.stringify({ profile: null }))
      if (String(url).endsWith('/sources') && options?.method === 'POST') {
        const id = JSON.parse(options.body as string)
          .url.split('/')
          .at(-1)
        return new Response(JSON.stringify({ errorCode: 'story_exists', errorMeta: { id, title: `Existing ${id}` } }), { status: 409 })
      }
      return new Response(JSON.stringify({ items: [], nextCursor: null }))
    })
    await wrapper!.get('textarea').setValue('https://archiveofourown.org/works/1\nhttps://archiveofourown.org/works/2')
    await wrapper!
      .findAll('button')
      .find((button) => button.text() === 'Import stories')!
      .trigger('click')
    await flushPromises()
    expect(wrapper!.get('[role="dialog"]').text()).toContain('Existing 1')
    expect(wrapper!.get('[role="dialog"]').text()).toContain('Story 1 of 2')
    await wrapper!
      .findAll('button')
      .find((button) => button.text() === 'Next')!
      .trigger('click')
    expect(wrapper!.get('[role="dialog"]').text()).toContain('Existing 2')
    await wrapper!
      .findAll('button')
      .find((button) => button.text() === 'Previous')!
      .trigger('click')
    expect(wrapper!.get('[role="dialog"]').text()).toContain('Existing 1')
    expect(wrapper!.findAll('article')).toHaveLength(0)
  })

  it('renders Profiles exclusively and exposes the active destination', async () => {
    await open('/fanfiction?tab=profiles')
    expect(wrapper!.find('source-profiles-stub').exists()).toBe(true)
    expect(wrapper!.text()).not.toContain('Recent story changes')
    expect(wrapper!.text()).not.toContain('No activity yet.')
    expect(wrapper!.get('nav a[aria-current="page"]').text()).toBe('Profiles')
  })

  it('starts with an actionable empty state instead of bulk configuration', async () => {
    await open()
    expect(wrapper!.text()).toContain('No stories yet.')
    expect(wrapper!.text()).not.toContain('No stories match your filters.')
    expect(wrapper!.text()).not.toContain('Bulk story actions')
  })

  it('restores filters and destination from the URL and clears no-result filters', async () => {
    const router = await open('/fanfiction?tab=stories&search=dragon&state=paused')
    expect(wrapper!.get('input[aria-label="Search stories"]').element).toHaveProperty('value', 'dragon')
    expect(wrapper!.text()).toContain('No stories match your filters.')
    const clear = wrapper!.findAll('button').find((button) => button.text() === 'Clear filters')!
    await clear.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.search).toBeUndefined()
    expect(router.currentRoute.value.query.state).toBeUndefined()
    expect(wrapper!.text()).toContain('No stories yet.')
    await router.push('/fanfiction?tab=activity')
    await flushPromises()
    expect(wrapper!.get('nav a[aria-current="page"]').text()).toBe('Activity')
    expect(wrapper!.text()).toContain('Recent story changes')
  })
})

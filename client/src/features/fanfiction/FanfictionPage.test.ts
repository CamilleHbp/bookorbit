import { ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import FanfictionPage from './FanfictionPage.vue'

vi.mock('@/features/collection/composables/useCollections', () => ({
  useCollections: () => ({ collections: ref([]), fetchCollections: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) }),
}))
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
    document.body.innerHTML = ''
    vi.clearAllMocks()
    vi.useRealTimers()
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
      attachTo: document.body,
      global: {
        plugins: [router],
        stubs: { DialogPortal: { template: '<div><slot /></div>' }, SourceProfileEditor: true, SourceProfiles: true, ExistingStories: true },
      },
    })
    await flushPromises()
    return router
  }

  it('keeps multiple pending reviews accessible without a confirmation modal', async () => {
    await open('/fanfiction?tab=add')
    vi.mocked(api).mockImplementation(async (url, options) => {
      if (String(url).includes('profile-match')) return new Response(JSON.stringify({ profile: null }))
      if (String(url).endsWith('/sources') && options?.method === 'POST') {
        const id = JSON.parse(options.body as string)
          .url.split('/')
          .at(-1)
        return new Response(
          JSON.stringify({
            errorCode: 'story_exists',
            errorMeta: { id, title: `Existing ${id}`, bookId: Number(id), attentionCode: 'metadata_review_required' },
          }),
          { status: 409 },
        )
      }
      return new Response(JSON.stringify({ items: [], nextCursor: null }))
    })
    await wrapper!.get('textarea').setValue('https://archiveofourown.org/works/1\nhttps://archiveofourown.org/works/2')
    await wrapper!
      .findAll('button')
      .find((button) => button.text() === 'Import stories')!
      .trigger('click')
    await flushPromises()
    expect(wrapper!.text()).toContain('Existing 1')
    expect(wrapper!.text()).toContain('Story 1 of 2')
    await wrapper!
      .findAll('button')
      .find((button) => button.text() === 'Next')!
      .trigger('click')
    expect(wrapper!.text()).toContain('Existing 2')
    await wrapper!
      .findAll('button')
      .find((button) => button.text() === 'Previous')!
      .trigger('click')
    expect(wrapper!.text()).toContain('Existing 1')
    expect(wrapper!.findAll('article')).toHaveLength(0)
  })

  it.each(['duplicate', 'resolved-alias', 'update-race'])('opens the metadata review from an existing import (%s)', async (scenario) => {
    const router = await open('/fanfiction?tab=add')
    const story = { id: 'existing', title: 'Humanitas', bookId: 1968, attentionCode: 'metadata_review_required' }
    vi.mocked(api).mockImplementation(async (url) => {
      const path = String(url)
      if (path.includes('profile-match')) return new Response(JSON.stringify({ profile: null }))
      if (path.endsWith('/sources')) {
        if (scenario === 'resolved-alias')
          return new Response(JSON.stringify({ id: 'import-job', kind: 'import', state: 'succeeded', result: { existingStory: story } }))
        return new Response(
          JSON.stringify({ errorCode: 'story_exists', errorMeta: scenario === 'update-race' ? { id: story.id, title: story.title } : story }),
          { status: 409 },
        )
      }
      if (path.endsWith('/check'))
        return new Response(JSON.stringify({ errorCode: 'metadata_review_required', errorMeta: { sourceId: story.id, bookId: 1968 } }), {
          status: 409,
        })
      return new Response(JSON.stringify({ items: [], nextCursor: null }))
    })
    await wrapper!.get('textarea').setValue('https://fiction.live/stories/Humanitas/x9YLdZ9X7cZAPehkZ')
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper!.find('[role="dialog"]').exists()).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe('/book/1968?tab=story-updates')
    expect(wrapper!.text()).not.toContain('Story source changed or requires attention')
    expect(vi.mocked(api).mock.calls.filter(([url]) => String(url).endsWith('/check'))).toHaveLength(scenario === 'update-race' ? 1 : 0)
  })

  it('keeps invalid input editable', async () => {
    await open('/fanfiction?tab=add')
    expect(wrapper!.findAll('details button').every((button) => button.attributes('type') === 'button')).toBe(true)
    await wrapper!.get('textarea').setValue('not a URL')
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper!.get('textarea').element).toHaveProperty('value', 'not a URL')
    expect(wrapper!.text()).toContain('Each story needs a valid HTTPS URL.')
    expect(wrapper!.text()).not.toContain('Import another batch')
  })

  it('replaces the form with progress, retains options for another batch, and focuses the URLs', async () => {
    vi.useFakeTimers()
    await open('/fanfiction?tab=add')
    const job = { id: 'import-1', kind: 'import', state: 'running', attempts: 1, result: null }
    vi.mocked(api).mockImplementation(async (url) => {
      if (String(url).includes('profile-match')) return new Response(JSON.stringify({ profile: null }))
      if (String(url).endsWith('/sources')) return new Response(JSON.stringify(job))
      if (String(url).endsWith('/jobs/status')) return new Response(JSON.stringify({ items: [job] }))
      return new Response(JSON.stringify({ items: [], nextCursor: null }))
    })
    await wrapper!
      .findAll('details select')
      .find((select) => select.text().includes('Weekly'))!
      .setValue('manual')
    await wrapper!.get('textarea').setValue('https://archiveofourown.org/works/1')
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper!.find('textarea').exists()).toBe(false)
    expect(wrapper!.find('details').exists()).toBe(false)
    expect(wrapper!.text()).toContain('0 of 1 stories processed')
    expect(wrapper!.text()).toContain('https://archiveofourown.org/works/1')
    expect(wrapper!.text()).not.toContain('Import another batch')
    job.state = 'succeeded'
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()
    expect(wrapper!.text()).toContain('Batch finished')
    expect(wrapper!.text()).toContain('1 of 1 stories processed')
    await wrapper!
      .findAll('button')
      .find((button) => button.text() === 'Import another batch')!
      .trigger('click')
    await flushPromises()
    expect(wrapper!.get('textarea').element).toHaveProperty('value', '')
    expect(document.activeElement).toBe(wrapper!.get('textarea').element)
    expect(wrapper!.findAll('details select').find((select) => select.text().includes('Weekly'))!.element).toHaveProperty('value', 'manual')
    expect(wrapper!.findAll('article')).toHaveLength(0)
  })

  it('keeps interrupted submissions recoverable without restoring the form', async () => {
    await open('/fanfiction?tab=add')
    vi.mocked(api).mockRejectedValue(new Error('Offline'))
    await wrapper!.get('textarea').setValue('https://archiveofourown.org/works/1')
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper!.find('textarea').exists()).toBe(false)
    expect(wrapper!.text()).toContain('Offline')
    expect(wrapper!.text()).toContain('Waiting to submit')
    expect(wrapper!.text()).not.toContain('Import another batch')
    vi.mocked(api).mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes('profile-match')
              ? { profile: null }
              : { id: 'import-1', kind: 'import', state: 'failed', attempts: 1, result: null },
          ),
        ),
    )
    await wrapper!
      .findAll('button')
      .find((button) => button.text() === 'Retry remaining stories')!
      .trigger('click')
    await flushPromises()
    expect(wrapper!.text()).toContain('Batch finished with errors')
    expect(wrapper!.text()).toContain('Import another batch')
    expect(wrapper!.findAll('button').some((button) => button.text() === 'Retry')).toBe(true)
  })

  it('offers another batch above and below longer results, including cancelled stories', async () => {
    await open('/fanfiction?tab=add')
    vi.mocked(api).mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes('profile-match')
              ? { profile: null }
              : { id: String(url), kind: 'import', state: 'cancelled', attempts: 1, result: null },
          ),
        ),
    )
    await wrapper!.get('textarea').setValue([1, 2, 3, 4].map((id) => `https://archiveofourown.org/works/${id}`).join('\n'))
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper!.findAll('article')).toHaveLength(4)
    expect(wrapper!.findAll('button').filter((button) => button.text() === 'Import another batch')).toHaveLength(2)
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

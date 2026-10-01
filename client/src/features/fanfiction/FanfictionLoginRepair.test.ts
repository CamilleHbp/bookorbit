import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { ref } from 'vue'
import type { FanfictionSource } from '@bookorbit/types'
import { api } from '@/lib/api'
import FanfictionPage from './FanfictionPage.vue'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => true }) }))
vi.mock('@/features/collection/composables/useCollections', () => ({
  useCollections: () => ({ collections: ref([]), fetchCollections: vi.fn<() => Promise<void>>() }),
}))
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response
const source = {
  id: 'story',
  libraryId: 5,
  profileId: null,
  canonicalUrl: 'https://archiveofourown.org/works/1',
  site: 'archiveofourown.org',
  state: 'configuration_blocked',
  attentionCode: 'authentication_required',
  version: 1,
  bookId: 42,
  bookFileId: 43,
  title: 'Embers Fall',
  authors: ['Writer'],
  chapterCount: 32,
  wordCount: null,
  storyStatus: '',
  lastCheckedAt: null,
} as FanfictionSource
const website = { id: 'archiveofourown.org', name: 'Archive of Our Own', examples: [], access: 'login' }
const connection = { id: 'personal', website, version: 1, lastSuccessfulAt: null }
const profile = { id: 'login', name: 'AO3', libraryId: 5, version: 1, updatedAt: '', repairJobId: 'repair' }
afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('story login repair through the fanfiction page', () => {
  it('keeps the save event connected and opens the shared website repair using explicit personal access', async () => {
    vi.useFakeTimers()
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/fanfiction', name: 'fanfiction', component: FanfictionPage }] })
    await router.push('/fanfiction')
    await router.isReady()
    const writes: { url: string; body: Record<string, unknown> }[] = []
    let saved = false
    let finished = false
    vi.mocked(api).mockImplementation(async (path, init) => {
      const url = String(path)
      if (init?.method) {
        const body = JSON.parse(String(init.body))
        writes.push({ url, body })
        if (url === '/api/v1/fanfiction/connections') {
          saved = true
          return response(connection)
        }
        if (url.endsWith('/sources/story')) return response({ ...source, ...body, version: 2 })
        if (url.endsWith('/sources/story/check')) return response({ id: 'check', kind: 'update', state: 'queued', sourceId: 'story' })
      }
      if (url.endsWith('/connections/personal/retry'))
        return response({ id: 'repair', kind: 'source_batch', state: 'queued', result: { selection: { tracked: true } } })
      if (url.endsWith('/connections/websites')) return response([website])
      if (url.includes('/connections/issues/'))
        return response(saved && !finished ? [{ site: website.id, count: 2, connectionId: connection.id }] : [])
      if (url.endsWith('/connections')) return response([])
      if (url.includes('/profile-match?')) return response({ profile: null })
      if (url.endsWith('/sources/story')) return response(source)
      if (url.endsWith('/jobs/repair'))
        return response({ id: 'repair', kind: 'source_batch', state: finished ? 'succeeded' : 'queued', result: { selection: { tracked: true } } })
      if (url.includes('/fanfiction/libraries?')) return response({ items: [{ id: 5, name: 'Books' }], nextCursor: null })
      if (url.includes('/sources?')) return response({ items: finished && url.includes('view=attention') ? [] : [source], nextCursor: null })
      if (url.includes('/sources/folders?')) return response({ items: [{ id: 6, name: 'Books' }], nextCursor: null })
      if (url.includes('/profiles?')) return response({ items: saved ? [profile] : [], nextCursor: null })
      if (url.endsWith('/source-batches/repair/status'))
        return response({
          job: { id: 'repair', state: finished ? 'succeeded' : 'queued' },
          total: 2,
          checked: finished ? 2 : 0,
          updated: finished ? 2 : 0,
          unchanged: 0,
          needsAttention: 0,
          running: 0,
          waiting: finished ? 0 : 2,
          finished,
          trackingAvailable: true,
        })
      if (url.endsWith('/source-batches/scope')) return response({ total: 1, matching: 1 })
      return response({ items: [], nextCursor: null })
    })
    const wrapper = mount(FanfictionPage, {
      global: {
        plugins: [router],
        stubs: { RouterLink: { props: ['to'], template: '<a><slot /></a>' }, StoryReadingActions: true, StoryFilters: true, ExistingStories: true },
      },
    })
    try {
      await flushPromises()
      await wrapper
        .findAll('button')
        .find((button) => button.text() === 'Update website login')!
        .trigger('click')
      await flushPromises()
      const editor = wrapper.findAll('form').find((form) => form.text().includes('Archive of Our Own'))!
      await editor
        .findAll('label')
        .find((label) => label.text() === 'Username or email')!
        .get('input')
        .setValue('reader')
      await editor.trigger('submit')
      await flushPromises()
      expect(writes.map((write) => write.url)).toEqual([
        '/api/v1/fanfiction/connections',
        '/api/v1/libraries/5/fanfiction/sources/story',
        '/api/v1/fanfiction/connections/personal/retry',
      ])
      expect(vi.mocked(api).mock.calls.some(([url]) => String(url).endsWith('/source-batches/repair/status'))).toBe(true)
      await router.push('/fanfiction?tab=activity')
      await flushPromises()
      expect(wrapper.text()).toContain('2 stories need access')
      expect(wrapper.text()).toContain('Checking stories')
      finished = true
      await vi.advanceTimersByTimeAsync(3100)
      await flushPromises()
      expect(wrapper.text()).not.toContain('2 stories need access')
      expect(wrapper.text()).toContain('Library check complete')
    } finally {
      wrapper.unmount()
    }
  })
})

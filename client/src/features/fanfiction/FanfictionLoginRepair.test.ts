import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { ref } from 'vue'
import type { FanfictionSource } from '@bookorbit/types'
import { api } from '@/lib/api'
import FanfictionPage from './FanfictionPage.vue'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => true }) }))
vi.mock('@/features/collection/composables/useCollections', () => ({ useCollections: () => ({ collections: ref([]), fetchCollections: vi.fn() }) }))
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
const profile = { id: 'login', name: 'AO3', libraryId: 5, version: 1, updatedAt: '', repairJobId: 'repair' }
afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('story login repair through the fanfiction page', () => {
  it('keeps the save event connected and opens the shared website repair without per-story writes', async () => {
    vi.useFakeTimers()
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/fanfiction', name: 'fanfiction', component: FanfictionPage }] })
    await router.push('/fanfiction')
    await router.isReady()
    const writes: { url: string; body: Record<string, unknown> }[] = []
    let saved = false
    vi.mocked(api).mockImplementation(async (path, init) => {
      const url = String(path)
      if (init?.method) {
        const body = JSON.parse(String(init.body))
        writes.push({ url, body })
        if (url.endsWith('/profiles')) {
          saved = true
          return response(profile)
        }
        if (url.endsWith('/sources/story')) return response({ ...source, ...body, version: 2 })
        if (url.endsWith('/sources/story/check')) return response({ id: 'check', kind: 'update', state: 'queued', sourceId: 'story' })
      }
      if (url.includes('/profile-match?')) return response({ profile: null })
      if (url.endsWith('/sources/story')) return response(source)
      if (url.endsWith('/jobs/repair'))
        return response({ id: 'repair', kind: 'source_batch', state: 'queued', result: { selection: { tracked: true } } })
      if (url.includes('/fanfiction/libraries?')) return response({ items: [{ id: 5, name: 'Books' }], nextCursor: null })
      if (url.includes('/sources?')) return response({ items: [source], nextCursor: null })
      if (url.includes('/sources/folders?')) return response({ items: [{ id: 6, name: 'Books' }], nextCursor: null })
      if (url.includes('/profiles?')) return response({ items: saved ? [profile] : [], nextCursor: null })
      if (url.endsWith('/source-batches/repair/status'))
        return response({
          job: { id: 'repair', state: 'queued' },
          total: 2,
          checked: 0,
          running: 0,
          waiting: 2,
          finished: false,
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
      const editor = wrapper.findAll('form').find((form) => form.text().includes('archiveofourown.org login'))!
      await editor
        .findAll('label')
        .find((label) => label.text() === 'Username')!
        .get('input')
        .setValue('reader')
      await editor.trigger('submit')
      await flushPromises()
      expect(writes.map((write) => write.url)).toEqual(['/api/v1/libraries/5/fanfiction/profiles'])
      expect(vi.mocked(api).mock.calls.some(([url]) => String(url).endsWith('/source-batches/repair/status'))).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })
})

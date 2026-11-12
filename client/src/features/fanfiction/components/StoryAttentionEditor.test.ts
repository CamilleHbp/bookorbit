import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useBookStory } from '../composables/useBookStory'
import StoryUpdatesTab from './StoryUpdatesTab.vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FanfictionSource } from '@bookorbit/types'
import { api } from '@/lib/api'
import StoryAttentionEditor from './StoryAttentionEditor.vue'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>(), setOnAuthFailure: vi.fn<() => void>() }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => true }) }))
const source = {
  id: 'source',
  bookId: 7,
  libraryId: 5,
  title: 'Story',
  state: 'review_required',
  attentionCode: 'metadata_review_required',
  metadataReviewPending: true,
} as FanfictionSource
const values = { title: 'Story', description: '', authors: ['Writer'], genres: [], tags: [] }
const review = {
  jobId: 'review',
  review: { current: values, incoming: values, fields: ['tags'], lockedFields: [], fingerprint: 'hash', previousState: 'active' },
}
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('attention repair editor', () => {
  let wrapper: ReturnType<typeof mount>
  let saved = false
  let fail = false
  beforeEach(() => {
    saved = false
    fail = false
    vi.mocked(api).mockImplementation(async (url, options) => {
      const path = String(url)
      if (options?.method === 'POST') {
        if (fail) return respond({ message: 'Could not save' }, 500)
        saved = true
        return respond({ resolved: true })
      }
      if (path.endsWith('/metadata-review')) return respond(saved ? null : review)
      if (path.endsWith('/sources/source'))
        return respond(saved ? { ...source, state: 'active', attentionCode: null, metadataReviewPending: false } : source)
      return respond({ items: [], nextCursor: null })
    })
  })
  afterEach(() => {
    wrapper?.unmount()
    vi.restoreAllMocks()
  })
  async function open(standalone = false) {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/story', component: { template: '<div />' } },
        { path: '/fanfiction', name: 'fanfiction', component: { template: '<div />' } },
        { path: '/settings/website-logins', name: 'settings-website-logins', component: { template: '<div />' } },
      ],
    })
    await router.push('/story')
    await router.isReady()
    const component = standalone
      ? defineComponent({
          setup() {
            const state = useBookStory(7, 5, true, undefined, source.id)
            return () => h(StoryUpdatesTab, { state })
          },
        })
      : StoryAttentionEditor
    wrapper = mount(component, { attachTo: document.body, props: standalone ? {} : { source, busy: false }, global: { plugins: [router] } })
    await flushPromises()
    return router
  }
  const button = (label: string) => wrapper.findAll('button').find((item) => item.text() === label)!
  it('offers Save & next on standalone Story updates and continues into the attention queue', async () => {
    const router = await open(true)
    await button('Save & next').trigger('click')
    await flushPromises()
    expect(saved).toBe(true)
    expect(router.currentRoute.value.name).toBe('fanfiction')
    expect(router.currentRoute.value.query).toEqual({ tab: 'review', review: 'attention', libraryId: '5' })
  })
  it('stays on standalone Story updates when saving fails', async () => {
    fail = true
    const router = await open(true)
    await button('Save & next').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/story')
    expect(wrapper.text()).toContain('Could not save')
  })
  it('saves the metadata review and advances only after successful resolution', async () => {
    await open()
    await button('Save & next').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('next')).toEqual([[true]])
    expect(wrapper.text()).toContain('Resolved')
  })
  it('does not advance from a second save click while the first save is pending', async () => {
    const base = vi.mocked(api).getMockImplementation()!
    let finish: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    vi.mocked(api).mockImplementation(async (url, options) => {
      if (options?.method === 'POST') await pending
      return base(url, options)
    })
    await open()
    const save = button('Save & next')
    await Promise.all([save.trigger('click'), save.trigger('click')])
    await flushPromises()
    expect(wrapper.emitted('next')).toBeUndefined()
    finish()
    await flushPromises()
    expect(wrapper.emitted('next')).toEqual([[true]])
    expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  })
  it('keeps the current story and edits when saving fails', async () => {
    fail = true
    await open()
    await button('Save & next').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('next')).toBeUndefined()
    expect(wrapper.text()).toContain('Could not save')
    expect(button('Save & next')).toBeDefined()
  })
  it('does not call an unfinished retry resolved', async () => {
    vi.mocked(api).mockImplementation(async (url) => {
      const path = String(url)
      if (path.endsWith('/sources/source')) return respond({ ...source, state: 'active', attentionCode: null, metadataReviewPending: false })
      if (path.endsWith('/metadata-review')) return respond(null)
      if (path.includes('/jobs?')) return respond({ items: [{ id: 'pending', state: 'queued', kind: 'update' }], nextCursor: null })
      return respond({ items: [], nextCursor: null })
    })
    await open()
    expect(wrapper.text()).toContain('Update in progress')
    await button('Next').trigger('click')
    expect(wrapper.emitted('next')).toEqual([[false]])
  })
  it('removes a story that now has a website access problem without showing repair controls', async () => {
    const base = vi.mocked(api).getMockImplementation()!
    vi.mocked(api).mockImplementation((url, options) =>
      String(url).endsWith('/sources/source')
        ? Promise.resolve(respond({ ...source, attentionCode: 'authentication_required', metadataReviewPending: true }))
        : base(url, options),
    )
    await open()
    expect(wrapper.emitted('excluded')).toEqual([[]])
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(vi.mocked(api).mock.calls.some(([, options]) => options?.method)).toBe(false)
  })
  it('protects uncommitted tag edits before skipping', async () => {
    await open()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await wrapper.get('input[role="combobox"]').setValue('Unsaved tag')
    await button('Skip & next').trigger('click')
    await flushPromises()
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(wrapper.emitted('next')).toBeUndefined()
    expect(wrapper.text()).toContain('Unsaved tag')
  })
})

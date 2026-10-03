import { mount, flushPromises } from '@vue/test-utils'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import StoryReviewQueue from './StoryReviewQueue.vue'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const permissions = vi.hoisted(() => ({ edit: true }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => permissions.edit }) }))
const values = { title: 'Story', description: '', authors: [], genres: [], tags: ['Existing'] }
const review = {
  jobId: 'job',
  review: { current: values, incoming: values, fields: ['tags'], lockedFields: [], fingerprint: 'hash', previousState: 'active' },
}

describe('story review editor navigation', () => {
  let wrapper: ReturnType<typeof mount>
  beforeEach(() => {
    permissions.edit = true
    vi.mocked(api).mockImplementation(async (path, options) => {
      const data = options?.method
        ? { resolved: true }
        : String(path).includes('/sources?')
          ? {
              items: [1, 2].map((id) => ({
                id: String(id),
                bookId: id,
                title: `Story ${id}`,
                canonicalUrl: 'https://example.org/story',
                site: 'example.org',
              })),
              nextCursor: null,
            }
          : String(path).endsWith('/metadata-review')
            ? review
            : { ...values, lockedFields: [] }
      return new Response(JSON.stringify(data))
    })
  })
  afterEach(() => {
    wrapper?.unmount()
    vi.restoreAllMocks()
  })
  async function open() {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/review', component: StoryReviewQueue, props: { libraryId: 5 } },
        { path: '/elsewhere', component: { template: '<p>Elsewhere</p>' } },
      ],
    })
    await router.push('/review')
    await router.isReady()
    wrapper = mount(RouterView, { global: { plugins: [router] } })
    await flushPromises()
    return router
  }
  const button = (text: string) => wrapper.findAll('button').find((item) => item.text() === text)!
  it('commits a typed tag to the local draft before skipping and restores it on Previous', async () => {
    await open()
    await wrapper.get('input[role="combobox"]').setValue('Draft tag')
    await button('Skip & next').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Story 2')
    await button('Previous').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Draft tag')
    expect(vi.mocked(api).mock.calls.some(([, options]) => options?.method)).toBe(false)
  })
  it('saves and advances, then shows a saved story without submitting it again', async () => {
    await open()
    await button('Save & next').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('1 saved · 0 skipped')
    await button('Previous').trigger('click')
    await flushPromises()
    expect(button('Next')).toBeDefined()
    expect(button('Save & next')).toBeUndefined()
  })
  it('protects unsaved tag input when leaving the route', async () => {
    const router = await open()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await wrapper.get('input[role="combobox"]').setValue('Unsaved')
    await router.push('/elsewhere')
    expect(router.currentRoute.value.path).toBe('/review')
    expect(window.confirm).toHaveBeenCalledOnce()
  })
  it('hides ordinary metadata saving without the edit permission', async () => {
    permissions.edit = false
    const fallback = vi.mocked(api).getMockImplementation()!
    vi.mocked(api).mockImplementation((path, options) =>
      String(path).endsWith('/metadata-review') ? Promise.resolve(new Response('null')) : fallback(path, options),
    )
    await open()
    expect(button('Save & next')).toBeUndefined()
    expect(wrapper.text()).toContain('You don’t have permission')
    expect(wrapper.get('input').attributes('disabled')).toBeDefined()
  })
})

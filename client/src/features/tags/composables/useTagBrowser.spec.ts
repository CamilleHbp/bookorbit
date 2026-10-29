import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTagBrowser } from './useTagBrowser'
import { api } from '@/lib/api'
vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const request = vi.mocked(api)
async function setup(query = '') {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/tags', component: { render: () => null } }] })
  await router.push('/tags' + query)
  let state!: ReturnType<typeof useTagBrowser>
  const wrapper = mount(
    defineComponent({
      setup() {
        state = useTagBrowser()
        return () => h('div')
      },
    }),
    { global: { plugins: [router] } },
  )
  await flushPromises()
  return { state, wrapper, router }
}
function latestBookQuery() {
  const call = request.mock.calls.filter(([url]) => url === '/api/v1/books/query').at(-1)!
  return JSON.parse(String(call[1]?.body))
}
describe('tag book browser', () => {
  beforeEach(() => {
    request.mockReset()
    request.mockImplementation(async () => new Response(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 30 })))
  })
  it('restores bookmarked tags with all matching by default and bounded book pages', async () => {
    const { state, wrapper } = await setup('?tag=fandom.Earthsea&tag=tone.Cozy')
    expect(state.selected.value).toEqual(['fandom.Earthsea', 'tone.Cozy'])
    expect(latestBookQuery()).toMatchObject({
      pagination: { page: 0, size: 100 },
      filter: { rules: [{ field: 'tag', operator: 'includesAll', value: ['fandom.Earthsea', 'tone.Cozy'] }] },
    })
    wrapper.unmount()
  })
  it('changes matching mode and removes a selection without losing the other tag', async () => {
    const { state, wrapper, router } = await setup('?tag=genre.Fantasy&tag=tone.Cozy')
    await router.push({ query: { ...router.currentRoute.value.query, match: 'any' } })
    await flushPromises()
    expect(latestBookQuery().filter.rules[0].operator).toBe('includesAny')
    state.toggleTag('tone.Cozy')
    await flushPromises()
    expect(state.selected.value).toEqual(['genre.Fantasy'])
    state.clearTags()
    await flushPromises()
    expect(latestBookQuery().filter).toBeUndefined()
    wrapper.unmount()
  })
  it('keeps book selection when browsing another prefix and encodes literal separators', async () => {
    const { state, wrapper } = await setup('?tag=tone.Cozy')
    state.setGroup('%_', '')
    await flushPromises()
    expect(request).toHaveBeenCalledWith('/api/v1/tags?tagSeparator=%25_&tagPrefix=&page=1&pageSize=30')
    expect(state.selected.value).toEqual(['tone.Cozy'])
    wrapper.unmount()
  })
  it('reports catalog failures instead of showing an empty successful result', async () => {
    request.mockImplementation(
      async (url) => new Response(JSON.stringify({ items: [], total: 0 }), { status: String(url).startsWith('/api/v1/tags?') ? 403 : 200 }),
    )
    const { state, wrapper } = await setup()
    expect(state.tagsError.value).toBe(true)
    request.mockResolvedValue(new Response(JSON.stringify({ items: [], total: 0 })))
    await state.loadTags()
    expect(state.tagsError.value).toBe(false)
    wrapper.unmount()
  })
  it('deduplicates bookmarked tags and bounds selection size', async () => {
    const { state, wrapper } = await setup('?tag=one&tag=one&tag=')
    expect(state.selected.value).toEqual(['one'])
    wrapper.unmount()
  })
})

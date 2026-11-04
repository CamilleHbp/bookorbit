import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import WebsiteConnections from './WebsiteConnections.vue'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const response = (body: unknown) => new Response(JSON.stringify(body))
afterEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

it('saves ScribbleHub username and password without requiring browser cookies', async () => {
  const website = { id: 'scribblehub.com', name: 'ScribbleHub', access: 'login', examples: [] }
  vi.mocked(api).mockImplementation((url, options) => {
    if (String(url).endsWith('/websites')) return Promise.resolve(response([website]))
    if (options?.method === 'POST') return Promise.resolve(response({ id: 'connection', website, hasPassword: true, version: 1 }))
    return Promise.resolve(response([]))
  })
  const wrapper = mount(WebsiteConnections, { props: { focusSite: 'www.scribblehub.com', repairsOnly: true } })
  try {
    await flushPromises()
    expect(wrapper.get('h3').text()).toBe('ScribbleHub')
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
    await wrapper.get('input[autocomplete="username"]').setValue('reader')
    await wrapper.get('input[autocomplete="current-password"]').setValue('private-password')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    const request = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'POST')!
    expect(request[0]).toBe('/api/v1/fanfiction/connections')
    expect(JSON.parse(request[1]!.body as string)).toEqual({ site: 'scribblehub.com', username: 'reader', password: 'private-password' })
    expect((wrapper.get('input[autocomplete="current-password"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.emitted('saved')).toHaveLength(1)
  } finally {
    wrapper.unmount()
  }
})

it('focuses a requested repair after the delayed website catalog makes the form available', async () => {
  let resolveCatalog!: (response: Response) => void
  vi.mocked(api).mockImplementation((url) =>
    String(url).endsWith('/websites')
      ? new Promise<Response>((resolve) => {
          resolveCatalog = resolve
        })
      : Promise.resolve(response([])),
  )
  const wrapper = mount(WebsiteConnections, { attachTo: document.body, props: { libraryId: 5, focusSite: 'archiveofourown.org', repairsOnly: true } })
  try {
    await flushPromises()
    expect(wrapper.find('form').exists()).toBe(false)
    resolveCatalog(response([{ id: 'archiveofourown.org', name: 'Archive of Our Own', access: 'login', examples: [] }]))
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('form').element)
    expect(wrapper.get('input[autocomplete="username"]').element).toBeTruthy()
  } finally {
    wrapper.unmount()
  }
})

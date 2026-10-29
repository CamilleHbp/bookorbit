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

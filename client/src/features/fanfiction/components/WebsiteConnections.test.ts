import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import WebsiteConnections from './WebsiteConnections.vue'

vi.mock('@/features/auth/composables/useAuth', () => ({ useAuth: () => ({ user: { value: { id: 7 } } }) }))
vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const response = (body: unknown) => new Response(JSON.stringify(body))
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
  configurable: true,
  value() {
    this.open = true
  },
})
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

it('loads and saves advanced FanFicFare settings from the login repair form', async () => {
  const website = { id: 'scribblehub.com', name: 'ScribbleHub', access: 'login', examples: [] }
  const login = { id: 'connection', website, hasPassword: true, version: 3 }
  const configuration = '[www.scribblehub.com]\nusername: ********\npassword: ********\nuse_flaresolverr_proxy: true'
  vi.mocked(api).mockImplementation((url, options) => {
    if (String(url).endsWith('/websites')) return Promise.resolve(response([website]))
    if (String(url).endsWith('/settings')) return Promise.resolve(response({ configuration, tagRules: [] }))
    if (options?.method === 'POST') return Promise.resolve(response({ ...login, version: 4 }))
    return Promise.resolve(response([login]))
  })
  const wrapper = mount(WebsiteConnections, { props: { focusSite: website.id, repairsOnly: true } })
  try {
    await flushPromises()
    const advanced = wrapper.findAll('details')[1]!
    ;(advanced.element as HTMLDetailsElement).open = true
    await advanced.trigger('toggle')
    await flushPromises()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe(configuration)
    const edited = configuration.replace('proxy: true', 'proxy: false')
    await wrapper.get('textarea').setValue(edited)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    const request = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'POST')!
    expect(JSON.parse(request[1]!.body as string)).toEqual({ site: website.id, version: 3, configuration: edited })
    expect(wrapper.emitted('saved')).toHaveLength(1)
  } finally {
    wrapper.unmount()
  }
})

it.each(['royalroad.com', 'fanfiction.net'])('saves %s email and password while leaving browser cookies optional', async (site) => {
  const website = { id: site, name: site, access: 'login', usernameKind: 'email', examples: [] }
  vi.mocked(api).mockImplementation((url, options) => {
    if (String(url).endsWith('/websites')) return Promise.resolve(response([website]))
    if (options?.method === 'POST') return Promise.resolve(response({ id: 'connection', website, hasPassword: true, version: 1 }))
    return Promise.resolve(response([]))
  })
  const wrapper = mount(WebsiteConnections, { props: { focusSite: site, repairsOnly: true } })
  try {
    await flushPromises()
    expect(wrapper.get('input[type="email"]').element).toBeTruthy()
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
    await wrapper.get('input[type="email"]').setValue('reader@example.com')
    await wrapper.get('input[autocomplete="current-password"]').setValue('private-password')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    const request = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'POST')!
    expect(JSON.parse(request[1]!.body as string)).toEqual({ site, username: 'reader@example.com', password: 'private-password' })
    const links = wrapper.findAll('dialog a')
    expect(links.map((link) => link.attributes('href'))).toEqual(site === 'fanfiction.net' ? ['https://www.fanfiction.net/login.php'] : [])
    expect(links.map((link) => link.attributes('target'))).toEqual(site === 'fanfiction.net' ? ['_blank'] : [])
    if (site === 'fanfiction.net') await wrapper.get('dialog').trigger('close')
    expect(wrapper.emitted('saved')).toHaveLength(1)
  } finally {
    wrapper.unmount()
  }
})

it('opens FanFiction.net sign-in and saves the login cookie for its story host', async () => {
  const website = { id: 'fanfiction.net', name: 'FanFiction.net', access: 'cookies', examples: [] }
  vi.mocked(api).mockImplementation((url, options) => {
    if (String(url).endsWith('/websites')) return Promise.resolve(response([website]))
    if (options?.method === 'POST') return Promise.resolve(response({ id: 'connection', website, version: 1 }))
    return Promise.resolve(response([]))
  })
  const wrapper = mount(WebsiteConnections, { props: { focusSite: website.id } })
  try {
    await flushPromises()
    expect(wrapper.get('form a').attributes('href')).toBe('https://www.fanfiction.net/login.php')
    const fields = wrapper.get('details').findAll('input')
    await fields[0]!.setValue('session')
    await fields[1]!.setValue('example')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    const request = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'POST')!
    expect(JSON.parse(request[1]!.body as string)).toEqual({
      site: 'fanfiction.net',
      cookies: [{ name: 'session', value: 'example', domain: 'www.fanfiction.net', path: '/', secure: true }],
    })
  } finally {
    wrapper.unmount()
  }
})

it('orders websites by their visible labels and keeps archive paths and connection IDs', async () => {
  const catalog = ['www.Zebra.org', 'https://www.alpha.org/fiction/', 'http://alpha.org/archive', 'Royal Road'].map((name, index) => ({
    name,
    id: 'site-' + index,
    examples: [],
    access: 'cookies',
  }))
  vi.mocked(api).mockImplementation((url) => Promise.resolve(response(String(url).endsWith('/websites') ? catalog : [])))
  const wrapper = mount(WebsiteConnections)
  try {
    await flushPromises()
    const options = wrapper.findAll('select option').slice(1)
    expect(options.map((item) => [item.text(), item.attributes('value')])).toEqual([
      ['alpha.org/archive', 'site-2'],
      ['alpha.org/fiction', 'site-1'],
      ['Royal Road', 'site-3'],
      ['Zebra.org', 'site-0'],
    ])
  } finally {
    wrapper.unmount()
  }
})

it('retries only the selected saved website and prevents repeated clicks while the request is pending', async () => {
  const website = { id: 'fanfiction.net', name: 'FanFiction.net', access: 'login', examples: [] }
  let finish!: (res: Response) => void
  vi.mocked(api).mockImplementation((url, options) => {
    if (options?.method === 'POST')
      return new Promise((resolve) => {
        finish = resolve
      })
    if (String(url).endsWith('/websites')) return Promise.resolve(response([website]))
    return Promise.resolve(response([{ id: 'saved-login', website, version: 1 }]))
  })
  const wrapper = mount(WebsiteConnections)
  try {
    await flushPromises()
    const retry = wrapper.get('button[title]')
    expect(retry.attributes('aria-label')).toBe(retry.attributes('title'))
    expect(retry.attributes('title')).toContain('FanFiction.net')
    await retry.trigger('click')
    await retry.trigger('click')
    const requests = vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(requests).toHaveLength(1)
    expect(requests[0]![0]).toBe('/api/v1/fanfiction/connections/saved-login/retry-downloads')
    expect(JSON.parse(requests[0]![1]!.body as string)).toEqual({})
    expect(retry.attributes('disabled')).toBeDefined()
    finish(response({ queued: 42, skipped: 0 }))
    await flushPromises()
    expect(retry.attributes('disabled')).toBeUndefined()
  } finally {
    wrapper.unmount()
  }
})

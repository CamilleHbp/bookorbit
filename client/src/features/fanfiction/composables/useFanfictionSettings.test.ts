import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFanfictionSettings } from './useFanfictionSettings'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const mockApi = vi.mocked(api)
const response = (value: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => value }) as Response

describe('Fanfiction settings API contract', () => {
  let scope: ReturnType<typeof effectScope>
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    scope = effectScope()
  })
  afterEach(() => {
    scope.stop()
    vi.useRealTimers()
  })
  function settings() {
    return scope.run(() => useFanfictionSettings())!
  }
  it('requires confirmation and clears the deleted profile and editor after an empty response', async () => {
    const state = settings()
    state.libraryId.value = 5
    const profile = { id: 'profile', libraryId: 5, name: 'AO3', version: 1, updatedAt: '' }
    state.profiles.value = [profile]
    state.previewProfileId.value = profile.id
    state.editing.value = { ...profile, configuration: '', cookies: [], cookieCount: 0 }
    state.showEditor.value = true
    state.password.value = 'unsaved-secret'
    await state.deleteProfile()
    expect(mockApi).not.toHaveBeenCalled()
    state.requestDelete(profile)
    expect(mockApi).not.toHaveBeenCalled()
    mockApi.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await state.deleteProfile()).toBe(profile.id)
    expect(mockApi).toHaveBeenCalledWith('/api/v1/libraries/5/fanfiction/profiles/profile', { method: 'DELETE' })
    expect(state.profiles.value).toEqual([])
    expect(state.deleting.value).toBeNull()
    expect(state.previewProfileId.value).toBe('')
    expect(state.showEditor.value).toBe(false)
    expect(state.password.value).toBe('')
  })
  it('keeps the profile and confirmation open when deletion is blocked', async () => {
    const state = settings()
    state.libraryId.value = 5
    const profile = { id: 'profile', libraryId: 5, name: 'AO3', version: 1, updatedAt: '' }
    state.profiles.value = [profile]
    state.requestDelete(profile)
    mockApi.mockResolvedValueOnce(response({ message: 'This profile is assigned to stories.' }, false))
    expect(await state.deleteProfile()).toBeUndefined()
    expect(state.profiles.value).toEqual([profile])
    expect(state.deleting.value).toEqual(profile)
    expect(state.error.value).toBe('This profile is assigned to stories.')
    state.cancelDelete()
    expect(state.deleting.value).toBeNull()
  })
  it('ignores a deletion response after switching libraries', async () => {
    const state = settings()
    state.libraryId.value = 5
    const profile = { id: 'profile', libraryId: 5, name: 'AO3', version: 1, updatedAt: '' }
    state.requestDelete(profile)
    let resolve!: (value: Response) => void
    mockApi.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const pending = state.deleteProfile()
    state.setLibrary(6)
    state.profiles.value = [{ ...profile, libraryId: 6 }]
    resolve(new Response(null, { status: 204 }))
    expect(await pending).toBeUndefined()
    expect(state.profiles.value).toHaveLength(1)
    expect(state.deleting.value).toBeNull()
  })
  it('loads only administrable libraries and bounded profile/activity pages', async () => {
    mockApi.mockImplementation(async (path) => {
      if (String(path).startsWith('/api/v1/fanfiction/libraries')) return response({ items: [{ id: 5, name: 'Stories' }], nextCursor: null })
      if (String(path).endsWith('/runtime')) return response({ version: '4.61.0', protocolVersion: 1, ready: true })
      return response({ items: [], nextCursor: null })
    })
    const state = settings()
    await state.loadLibraries()
    expect(state.libraryId.value).toBe(5)
    expect(state.health.value?.ready).toBe(true)
    expect(mockApi.mock.calls.map((call) => call[0])).toContain('/api/v1/libraries/5/fanfiction/profiles?limit=50')
    expect(mockApi.mock.calls.map((call) => call[0])).toContain('/api/v1/libraries/5/fanfiction/jobs?limit=50')
  })
  it('sends only profile DTO fields and omits unchanged credentials', async () => {
    const state = settings()
    state.libraryId.value = 5
    state.newProfile()
    state.name.value = 'AO3'
    state.configuration.value = '[defaults]\ninclude_images: true\n'
    mockApi.mockResolvedValue(response({ items: [], nextCursor: null }))
    await state.saveProfile()
    const [url, options] = mockApi.mock.calls[0]!
    expect(url).toBe('/api/v1/libraries/5/fanfiction/profiles')
    expect(JSON.parse(options!.body as string)).toEqual({ name: 'AO3', configuration: '[defaults]\ninclude_images: true\n' })
    expect(options!.method).toBe('POST')
  })
  it('reuses the durable request identity after an uncertain preview response', async () => {
    const state = settings()
    state.libraryId.value = 5
    state.previewUrl.value = 'https://archiveofourown.org/works/123'
    mockApi.mockRejectedValueOnce(new Error('connection interrupted')).mockResolvedValueOnce(response({ id: 'job', state: 'queued' }))
    await state.preview()
    await state.preview()
    const first = JSON.parse(mockApi.mock.calls[0]![1]!.body as string)
    const second = JSON.parse(mockApi.mock.calls[1]![1]!.body as string)
    expect(first).toEqual(second)
    expect(first).toEqual({ url: state.previewUrl.value, idempotencyKey: expect.any(String) })
    expect(state.jobs.value[0]?.id).toBe('job')
  })
  it('preserves masked cookies, sends only DTO fields, and clears secrets after saving', async () => {
    const state = settings()
    state.libraryId.value = 5
    const profile = { id: 'profile', libraryId: 5, name: 'AO3', version: 3, updatedAt: '2026-09-06T12:00:00Z' }
    const cookie = { name: 'session', value: '********', domain: 'archiveofourown.org', path: '/', secure: true }
    mockApi.mockResolvedValueOnce(response({ ...profile, configuration: '[defaults]\n', cookieCount: 1, cookies: [cookie] }))
    await state.editProfile(profile)
    expect(state.cookieRows.value[0]?.value).toBe('********')
    state.addCookie()
    Object.assign(state.cookies.value[1]!, { name: 'another', domain: cookie.domain, value: 'replacement-secret' })
    state.changeCookies()
    mockApi.mockResolvedValue(response({ items: [], nextCursor: null }))
    await state.saveProfile()
    const sent = mockApi.mock.calls.find(([, options]) => options?.method === 'PATCH')!
    const body = JSON.parse(sent[1]!.body as string)
    expect(body.version).toBe(3)
    expect(body.cookies).toEqual([cookie, { ...cookie, name: 'another', value: 'replacement-secret' }])
    expect(state.cookies.value).toEqual([])
    expect(state.showEditor.value).toBe(false)
  })
  it('omits untouched cookie values and submits explicit cookie removal', async () => {
    const state = settings()
    state.libraryId.value = 5
    const profile = { id: 'profile', libraryId: 5, name: 'AO3', version: 1, updatedAt: '' }
    const view = {
      ...profile,
      configuration: '',
      cookieCount: 1,
      cookies: [{ name: 'session', value: '********', domain: 'example.org', path: '/', secure: true }],
    }
    mockApi.mockResolvedValueOnce(response(view))
    await state.editProfile(profile)
    mockApi.mockResolvedValue(response({ items: [], nextCursor: null }))
    await state.saveProfile()
    let requests = mockApi.mock.calls.filter(([, options]) => options?.method === 'PATCH')
    expect(JSON.parse(requests[0]![1]!.body as string).cookies).toBeUndefined()
    mockApi.mockResolvedValueOnce(response(view))
    await state.editProfile(profile)
    state.clearCookies()
    await state.saveProfile()
    requests = mockApi.mock.calls.filter(([, options]) => options?.method === 'PATCH')
    expect(JSON.parse(requests[1]![1]!.body as string).cookies).toEqual([])
  })
  it('bounds cookie rendering and removes unsaved secrets when the editor closes', () => {
    const state = settings()
    state.newProfile()
    for (let i = 0; i < 201; i++) state.addCookie()
    expect(state.cookies.value).toHaveLength(200)
    expect(state.cookieRows.value).toHaveLength(10)
    expect(state.cookiePage.value).toBe(19)
    state.previousCookies()
    expect(state.cookiePage.value).toBe(18)
    state.removeCookie(state.cookieRows.value[0]!.key)
    expect(state.cookies.value).toHaveLength(199)
    state.closeEditor()
    expect(state.cookies.value).toEqual([])
    expect(state.cookiePage.value).toBe(0)
  })
  it('creates a Fiction.live preset with explicit age confirmation and selects the saved profile for testing', async () => {
    const state = settings()
    state.libraryId.value = 5
    state.newProfile()
    state.presetId.value = 'fictionlive'
    state.applyPreset()
    expect(state.section.value).toBe('fiction.live')
    expect(state.isAdult.value).toBe(false)
    state.isAdult.value = true
    state.changeAdult()
    const profile = { id: 'saved-profile', libraryId: 5, name: 'Fiction.live', version: 1, updatedAt: '' }
    mockApi.mockResolvedValueOnce(response(profile)).mockResolvedValueOnce(response({ items: [profile], nextCursor: null }))
    expect(await state.saveProfile()).toEqual(profile)
    const body = JSON.parse(mockApi.mock.calls[0]![1]!.body as string)
    expect(body.credentials).toEqual({ section: 'fiction.live', isAdult: true })
    expect(body.configuration).toContain('dedup_img_files: true')
    expect(body.configuration).not.toContain('is_adult')
    expect(state.previewProfileId.value).toBe('saved-profile')
    expect(state.isAdult.value).toBe(false)
  })

  it('reopens the correct site section and preserves secrets when only age confirmation changes', async () => {
    const state = settings()
    state.libraryId.value = 5
    const profile = { id: 'profile', libraryId: 5, name: 'My fiction', version: 3, updatedAt: '' }
    mockApi.mockResolvedValueOnce(
      response({ ...profile, configuration: '[fiction.live]\nusername = reader\npassword = ********\nis_adult = true\n', cookies: [] }),
    )
    await state.editProfile(profile)
    expect(state.section.value).toBe('fiction.live')
    expect(state.presetId.value).toBe('fictionlive')
    expect(state.isAdult.value).toBe(true)
    state.isAdult.value = false
    state.changeAdult()
    mockApi.mockResolvedValue(response({ items: [], nextCursor: null }))
    await state.saveProfile()
    const body = JSON.parse(mockApi.mock.calls.find(([, options]) => options?.method === 'PATCH')![1]!.body as string)
    expect(body.credentials).toEqual({ section: 'fiction.live', isAdult: false })
    expect(body.configuration).toContain('password = ********')
  })

  it('does not carry credentials or age confirmation from one site preset to another', () => {
    const state = settings()
    state.newProfile()
    state.presetId.value = 'ao3'
    state.applyPreset()
    state.username.value = 'reader'
    state.changeUsername()
    state.password.value = 'secret'
    state.changePassword()
    state.isAdult.value = true
    state.changeAdult()
    state.addCookie()
    state.cookies.value[0]!.value = 'session-secret'
    state.presetId.value = 'fictionlive'
    state.applyPreset()
    expect(state.cookies.value).toEqual([])
    expect(state.username.value).toBe('')
    expect(state.password.value).toBe('')
    expect(state.isAdult.value).toBe(false)
    state.presetId.value = ''
    state.applyPreset()
    expect(state.section.value).toBe('defaults')
    expect(state.configuration.value).toBe('')
  })
})

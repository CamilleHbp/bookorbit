import { effectScope, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { FanfictionProfileSummary, FanfictionSource } from '@bookorbit/types'
import SourceProfileEditor from '../components/SourceProfileEditor.vue'
import { api } from '@/lib/api'
import { useInlineSourceSettings } from './useInlineSourceSettings'
import { sourcePresetForUrl } from '../lib/source-presets'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))

describe('source setup while adding stories', () => {
  it('detects the pasted site and clears unsaved settings when changing libraries', async () => {
    const scope = effectScope()
    try {
      const library = ref<number | null>(5)
      const urls = ref('https://fiction.live/stories/Example/17CharacterIDhere/home')
      const state = scope.run(() => useInlineSourceSettings(library, ref([]), ref(''), urls))!
      state.addSource()
      expect(state.sourceSettings.libraryId).toBe(5)
      expect(state.sourceSettings.section).toBe('fiction.live')
      expect(state.sourceSettings.showEditor).toBe(true)
      state.sourceSettings.password = 'unsaved-secret'
      library.value = 6
      await nextTick()
      expect(state.sourceSettings.libraryId).toBe(6)
      expect(state.sourceSettings.password).toBe('')
      expect(state.sourceSettings.showEditor).toBe(false)
      expect(urls.value).toContain('fiction.live')
    } finally {
      scope.stop()
    }
  })

  it('does not suggest a trusted site preset for lookalike domains or unsafe URLs', () => {
    for (const url of ['https://fiction.live.example.org/story', 'https://fiction.live@evil.example/story', 'file:///fiction.live', 'invalid']) {
      expect(sourcePresetForUrl(url)).toBeUndefined()
    }
    expect(sourcePresetForUrl('https://beta.fiction.live/stories/example/id')?.id).toBe('fictionlive')
  })
})

const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response
const source = {
  id: 'story',
  libraryId: 5,
  profileId: null,
  canonicalUrl: 'https://archiveofourown.org/works/1',
  site: 'archiveofourown.org',
  state: 'configuration_blocked',
  attentionCode: 'authentication_required',
  version: 3,
  bookFileId: 10,
} as FanfictionSource
const profile = { id: 'login', name: 'AO3', libraryId: 5, version: 1, updatedAt: '' } as FanfictionProfileSummary
const savedProfile = { ...profile, configuration: '[archiveofourown.org]\nusername: existing-user\n', rootUrls: ['https://archiveofourown.org'] }
const mockApi = vi.mocked(api)

describe('website login recovery', () => {
  beforeEach(() => vi.clearAllMocks())

  it('opens and saves the shared AO3 login without changing individual stories', async () => {
    const scope = effectScope()
    const state = scope.run(() => useInlineSourceSettings(ref(5), ref([]), ref(''), ref('')))!
    mockApi.mockResolvedValueOnce(response(source)).mockResolvedValueOnce(response({ profile: null }))
    await state.editStoryLogin('story')
    expect(state.sourceSettings.showEditor).toBe(true)
    expect(state.sourceSettings.section).toBe('archiveofourown.org')
    expect(state.sourceSettings.rootUrls).toContain('https://archiveofourown.org')
    const wrapper = mount(SourceProfileEditor, {
      props: {
        settings: state.sourceSettings,
        compact: true,
        loginSite: source.site,
        saveLabel: 'Save and check again',
      },
    })
    expect(wrapper.get('h2').text()).toBe('archiveofourown.org login')
    expect(wrapper.text()).not.toContain('Root URLs')
    const username = wrapper
      .findAll('label')
      .find((label) => label.text() === 'Username')!
      .get('input')
    await username.setValue('reader')
    mockApi.mockResolvedValueOnce(response(profile)).mockResolvedValueOnce(response({ items: [profile], nextCursor: null }))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    const saved = wrapper.emitted('saved')![0]![0] as FanfictionProfileSummary
    const save = mockApi.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(JSON.parse(save[1]!.body as string).credentials).toEqual({ section: 'archiveofourown.org', username: 'reader' })
    expect(saved.id).toBe(profile.id)
    expect(mockApi.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1)
    wrapper.unmount()
    scope.stop()
  })

  it.each([null, 'login'])('reuses matching or assigned credentials (%s) and selects the correct website in a shared profile', async (profileId) => {
    const scope = effectScope()
    try {
      const state = scope.run(() => useInlineSourceSettings(ref(5), ref([]), ref(''), ref('')))!
      mockApi.mockResolvedValueOnce(response({ ...source, profileId }))
      if (!profileId) mockApi.mockResolvedValueOnce(response({ profile }))
      mockApi.mockResolvedValueOnce(
        response({ ...savedProfile, configuration: savedProfile.configuration + '[forums.spacebattles.com]\nusername: other-user\n' }),
      )
      await state.editStoryLogin('story')
      expect(state.sourceSettings.editing?.id).toBe('login')
      expect(state.sourceSettings.username).toBe('existing-user')
      expect(state.sourceSettings.section).toBe('archiveofourown.org')
    } finally {
      scope.stop()
    }
  })

  it('discards a late repair response after changing libraries and never applies credentials across libraries', async () => {
    const scope = effectScope()
    try {
      const library = ref<number | null>(5)
      const state = scope.run(() => useInlineSourceSettings(library, ref([]), ref(''), ref('')))!
      let resolve!: (value: Response) => void
      mockApi.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          }),
      )
      const pending = state.editStoryLogin('story')
      library.value = 6
      await nextTick()
      resolve(response(source))
      await pending
      expect(state.sourceSettings.showEditor).toBe(false)
      expect(state.repairingSource.value).toBeNull()
      expect(mockApi).toHaveBeenCalledTimes(1)
    } finally {
      scope.stop()
    }
  })

  it('does not reopen a late profile response after leaving the login editor', async () => {
    const scope = effectScope()
    try {
      const state = scope.run(() => useInlineSourceSettings(ref(5), ref([]), ref(''), ref('')))!
      let resolve!: (value: Response) => void
      mockApi.mockResolvedValueOnce(response({ ...source, profileId: profile.id }))
      mockApi.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          }),
      )
      const pending = state.editStoryLogin('story')
      await flushPromises()
      state.cancelStoryLogin()
      resolve(response(savedProfile))
      await pending
      expect(state.sourceSettings.showEditor).toBe(false)
      expect(state.repairingSource.value).toBeNull()
      expect(state.repairing.value).toBe(false)
    } finally {
      scope.stop()
    }
  })

  it('shows a recoverable loading error instead of opening an unrelated profile', async () => {
    const scope = effectScope()
    try {
      const state = scope.run(() => useInlineSourceSettings(ref(5), ref([]), ref(''), ref('')))!
      mockApi.mockRejectedValueOnce(new Error('Unable to load website login'))
      await state.editStoryLogin('story')
      expect(state.sourceSettings.error).toBe('Unable to load website login')
      expect(state.sourceSettings.showEditor).toBe(false)
      expect(state.repairing.value).toBe(false)
    } finally {
      scope.stop()
    }
  })
})

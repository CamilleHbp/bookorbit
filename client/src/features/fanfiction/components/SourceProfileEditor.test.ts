import { effectScope, reactive } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import SourceProfileEditor from './SourceProfileEditor.vue'
import { useFanfictionSettings } from '../composables/useFanfictionSettings'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const scope = effectScope()
afterEach(() => vi.clearAllMocks())

describe('guided source editor', () => {
  it('saves a Fiction.live profile without age or login controls', async () => {
    const settings = scope.run(() => reactive(useFanfictionSettings()))!
    settings.libraryId = 5
    settings.newProfile()
    const wrapper = mount(SourceProfileEditor, { props: { settings } })
    try {
      await wrapper.get('select').setValue('fictionlive')
      expect(wrapper.find('input[autocomplete="off"]').exists()).toBe(false)
      expect(wrapper.get('details').attributes('open')).toBeUndefined()
      expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
      const profile = { id: 'saved', libraryId: 5, name: 'Fiction.live', version: 1, updatedAt: '' }
      vi.mocked(api)
        .mockResolvedValueOnce({ ok: true, json: async () => profile } as Response)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [profile], nextCursor: null }) } as Response)
      await wrapper.get('form').trigger('submit')
      await flushPromises()
      expect(JSON.parse(vi.mocked(api).mock.calls[0]![1]!.body as string).credentials).toBeUndefined()
      expect(wrapper.emitted('saved')).toEqual([[profile]])
    } finally {
      wrapper.unmount()
      scope.stop()
    }
  })
  it('saves a rule even when its target tag is still being typed', async () => {
    const localScope = effectScope()
    const settings = localScope.run(() => reactive(useFanfictionSettings()))!
    settings.libraryId = 5
    settings.newProfile()
    settings.name = 'AO3'
    const wrapper = mount(SourceProfileEditor, { props: { settings } })
    try {
      await wrapper
        .findAll('button')
        .find((button) => button.text() === 'Add tag rule')!
        .trigger('click')
      await wrapper.get('input[id*="remote"]').setValue('Remote adventure')
      await wrapper.get('input[id*="target"]').setValue('Adventure')
      const profile = { id: 'saved', libraryId: 5, name: 'AO3', version: 1, updatedAt: '' }
      vi.mocked(api)
        .mockResolvedValueOnce({ ok: true, json: async () => profile } as Response)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [profile], nextCursor: null }) } as Response)
      await wrapper.get('form').trigger('submit')
      await flushPromises()
      expect(JSON.parse(vi.mocked(api).mock.calls[0]![1]!.body as string).tagRules).toEqual([
        { remoteTag: 'Remote adventure', targetTag: 'Adventure' },
      ])
    } finally {
      wrapper.unmount()
      localScope.stop()
    }
  })
})

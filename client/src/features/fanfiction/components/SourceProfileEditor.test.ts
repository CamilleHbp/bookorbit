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
  it('offers age confirmation without a misleading Fiction.live login form and saves it', async () => {
    const settings = scope.run(() => reactive(useFanfictionSettings()))!
    settings.libraryId = 5
    settings.newProfile()
    const wrapper = mount(SourceProfileEditor, { props: { settings } })
    try {
      await wrapper.get('select').setValue('fictionlive')
      expect(wrapper.text()).toContain('does not use a Fiction.live username/password')
      expect(wrapper.find('input[autocomplete="off"]').exists()).toBe(false)
      expect(wrapper.get('details').attributes('open')).toBeUndefined()
      await wrapper.get('input[type="checkbox"]').setValue(true)
      const profile = { id: 'saved', libraryId: 5, name: 'Fiction.live', version: 1, updatedAt: '' }
      vi.mocked(api)
        .mockResolvedValueOnce({ ok: true, json: async () => profile } as Response)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [profile], nextCursor: null }) } as Response)
      await wrapper.get('form').trigger('submit')
      await flushPromises()
      expect(JSON.parse(vi.mocked(api).mock.calls[0]![1]!.body as string).credentials).toEqual({ section: 'fiction.live', isAdult: true })
      expect(wrapper.emitted('saved')).toEqual([[profile]])
    } finally {
      wrapper.unmount()
      scope.stop()
    }
  })
})

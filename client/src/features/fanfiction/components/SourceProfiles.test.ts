import { effectScope, reactive } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import SourceProfiles from './SourceProfiles.vue'
import { useFanfictionSettings } from '../composables/useFanfictionSettings'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
afterEach(() => vi.clearAllMocks())

describe('profile management', () => {
  it('offers deletion while the download service is unavailable and confirms the selected profile', async () => {
    const scope = effectScope()
    const settings = scope.run(() => reactive(useFanfictionSettings()))!
    settings.libraryId = 5
    settings.profiles = [{ id: 'profile', libraryId: 5, name: 'My AO3', version: 1, updatedAt: '' }]
    const wrapper = mount(SourceProfiles, { props: { settings }, global: { stubs: { ConfirmDialog: true } } })
    try {
      expect(wrapper.get('button[aria-label="Edit My AO3"]').attributes('disabled')).toBeDefined()
      const button = wrapper.get('button[aria-label="Delete My AO3?"]')
      expect(button.attributes('disabled')).toBeUndefined()
      await button.trigger('click')
      const dialog = wrapper.getComponent(ConfirmDialog)
      expect(dialog.props('open')).toBe(true)
      expect(dialog.props('title')).toBe('Delete My AO3?')
      expect(vi.mocked(api)).not.toHaveBeenCalled()
      dialog.vm.$emit('cancel')
      await flushPromises()
      expect(dialog.props('open')).toBe(false)
      expect(settings.profiles).toHaveLength(1)
      await button.trigger('click')
      vi.mocked(api).mockResolvedValueOnce(new Response(null, { status: 204 }))
      dialog.vm.$emit('confirm')
      await flushPromises()
      expect(wrapper.emitted('deleted')).toEqual([['profile']])
      expect(wrapper.find('li').exists()).toBe(false)
      expect(wrapper.text()).toContain('No profiles yet.')
    } finally {
      wrapper.unmount()
      scope.stop()
    }
  })
})

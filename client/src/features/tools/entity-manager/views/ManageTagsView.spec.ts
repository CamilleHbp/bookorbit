import { describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import ManageTagsView from './ManageTagsView.vue'
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => true }) }))
vi.mock('./EntityManagerView.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/features/tag-matching/TagMatchingPanel.vue', () => ({ default: { template: '<div />' } }))
const stubs = { RouterLink: { template: '<a><slot /></a>' }, EntityManagerView: true, TagMatchingPanel: true }
describe('Manage tags navigation', () => {
  it('shows the canonical tag manager by default', async () => {
    const wrapper = shallowMount(ManageTagsView, { global: { stubs } })
    await flushPromises()
    expect(wrapper.find('entity-manager-view-stub').exists()).toBe(true)
    expect(wrapper.find('tag-matching-panel-stub').exists()).toBe(false)
    expect(wrapper.findAll('a')[0]?.attributes('aria-current')).toBe('page')
  })
  it('opens matching inside Manage tags with an accessible active link', async () => {
    const wrapper = shallowMount(ManageTagsView, { props: { matching: true }, global: { stubs } })
    await flushPromises()
    expect(wrapper.find('tag-matching-panel-stub').exists()).toBe(true)
    expect(wrapper.find('entity-manager-view-stub').exists()).toBe(false)
    expect(wrapper.findAll('a')[1]?.attributes('aria-current')).toBe('page')
  })
})

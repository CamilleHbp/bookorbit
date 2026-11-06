import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomIcon, CustomIconPage } from '@bookorbit/types'
import AppearanceIconsSettings from '../AppearanceIconsSettings.vue'

const mockState = vi.hoisted(() => ({
  fetchIconPage: vi.fn<() => Promise<CustomIconPage>>(),
}))

vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => true }) }))
vi.mock('@/features/custom-icons/composables/useCustomIcons', () => ({
  useCustomIcons: () => ({
    fetchIconPage: mockState.fetchIconPage,
    fetchIconUsage: vi.fn<() => Promise<unknown>>(),
    updateCustomIcon: vi.fn<() => Promise<void>>(),
    replaceCustomIconSvg: vi.fn<() => Promise<void>>(),
    deleteCustomIcon: vi.fn<() => Promise<void>>(),
    bulkDeleteCustomIcons: vi.fn<() => Promise<unknown>>(),
  }),
}))
vi.mock('@/features/custom-icons/components/IconUploadDialog.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/AppIcon.vue', () => ({ default: { template: '<span />' } }))

function icon(slug: string): CustomIcon {
  return { slug, name: slug } as CustomIcon
}

async function mountSettings() {
  const wrapper = mount(AppearanceIconsSettings, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

describe('AppearanceIconsSettings selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState.fetchIconPage.mockResolvedValue({ items: ['a', 'b', 'c', 'd'].map(icon), total: 4 } as CustomIconPage)
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('selects a range of icons with Shift, all of them with Ctrl+A and none with Escape', async () => {
    const wrapper = await mountSettings()
    const checkboxes = () => wrapper.findAll('button.absolute')
    const tiles = () => wrapper.findAll('div.group')
    const selected = () => tiles().map((tile) => tile.classes().includes('ring-1'))

    await checkboxes()[0]!.trigger('click')
    await checkboxes()[2]!.trigger('click', { shiftKey: true })
    expect(selected()).toEqual([true, true, true, false])
    expect(wrapper.text()).toContain('3 selected')

    await checkboxes()[1]!.trigger('click', { shiftKey: true })
    expect(selected()).toEqual([true, false, false, false])

    await checkboxes()[0]!.trigger('keydown', { key: 'a', metaKey: true })
    expect(selected()).toEqual([true, true, true, true])

    await checkboxes()[0]!.trigger('keydown', { key: 'Escape' })
    expect(selected()).toEqual([false, false, false, false])
  })
})

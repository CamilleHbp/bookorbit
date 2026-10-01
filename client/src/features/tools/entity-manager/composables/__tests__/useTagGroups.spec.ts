import { defineComponent, nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTagGroups } from '../useTagGroups'
import type { browseTagGroups, saveTagGrouping } from '../../../api/entity-manager'

const mocks = vi.hoisted(() => ({ browse: vi.fn<typeof browseTagGroups>(), save: vi.fn<typeof saveTagGrouping>() }))
const user = ref({ id: 1, settings: {} as Record<string, unknown> })
vi.mock('@/features/auth/composables/useAuth', () => ({ useAuth: () => ({ user }) }))
vi.mock('../../../api/entity-manager', () => ({ browseTagGroups: mocks.browse, saveTagGrouping: mocks.save }))

function setup() {
  let state!: ReturnType<typeof useTagGroups>
  const wrapper = mount(
    defineComponent({
      setup() {
        state = useTagGroups()
        return () => null
      },
    }),
  )
  return { state, wrapper }
}

describe('tag grouping preferences and pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    user.value = { id: 1, settings: {} }
    mocks.browse.mockResolvedValue({ items: [{ prefix: 'topic', tagCount: 2 }], total: 1, page: 1, pageSize: 20 })
    mocks.save.mockResolvedValue(undefined)
  })

  it('loads the current account separator and keeps requests bounded', async () => {
    user.value.settings = { tagGrouping: { enabled: true, separator: '/' } }
    const { state, wrapper } = setup()
    await flushPromises()
    expect(mocks.browse).toHaveBeenCalledWith({ separator: '/', search: undefined, page: 1, pageSize: 20 })
    expect(state.groups.value).toEqual([{ prefix: 'topic', tagCount: 2 }])
    wrapper.unmount()
  })

  it('does not retain another account preference in module state', () => {
    user.value.settings = { tagGrouping: { enabled: false, separator: '-' } }
    const first = setup()
    expect(first.state.preferences.value.separator).toBe('-')
    expect(mocks.browse).not.toHaveBeenCalled()
    first.wrapper.unmount()
    user.value = { id: 2, settings: {} }
    const second = setup()
    expect(second.state.preferences.value.separator).toBe('.')
    second.wrapper.unmount()
  })

  it('applies the separator only after saving succeeds and clears the active prefix', async () => {
    const { state, wrapper } = setup()
    state.selectedPrefix.value = 'topic'
    state.separatorDraft.value = '::'
    await state.save()
    await flushPromises()
    expect(mocks.save).toHaveBeenCalledWith({ enabled: true, separator: '::' })
    expect(user.value.settings.tagGrouping).toEqual({ enabled: true, separator: '::' })
    expect(state.selectedPrefix.value).toBeUndefined()
    expect(mocks.browse).toHaveBeenLastCalledWith(expect.objectContaining({ separator: '::', page: 1 }))
    wrapper.unmount()
  })

  it('preserves the saved separator and active prefix on save failure', async () => {
    const { state, wrapper } = setup()
    mocks.save.mockRejectedValueOnce(new Error('offline'))
    state.selectedPrefix.value = 'topic'
    state.separatorDraft.value = '/'
    await state.save()
    expect(state.preferences.value.separator).toBe('.')
    expect(state.selectedPrefix.value).toBe('topic')
    expect(state.saveError.value).toBe(true)
    wrapper.unmount()
  })

  it('rejects invalid separators without sending them', async () => {
    const { state, wrapper } = setup()
    state.separatorDraft.value = ' '
    await state.save()
    expect(state.valid.value).toBe(false)
    expect(mocks.save).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('ignores older responses after the separator changes', async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof browseTagGroups>>) => void
    mocks.browse.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve
      }),
    )
    const { state, wrapper } = setup()
    state.separatorDraft.value = '/'
    await state.save()
    await flushPromises()
    resolveOld({ items: [{ prefix: 'stale', tagCount: 99 }], total: 1, page: 1, pageSize: 20 })
    await flushPromises()
    expect(state.groups.value[0]?.prefix).toBe('topic')
    wrapper.unmount()
  })

  it('keeps load errors distinct from an empty group list and supports retry', async () => {
    mocks.browse.mockRejectedValueOnce(new Error('offline'))
    const { state, wrapper } = setup()
    await flushPromises()
    expect(state.loadError.value).toBe(true)
    await state.refresh()
    expect(state.loadError.value).toBe(false)
    expect(state.groups.value).toHaveLength(1)
    wrapper.unmount()
  })

  it('requests the next group page without loading all tags', async () => {
    mocks.browse.mockResolvedValue({ items: [], total: 45, page: 2, pageSize: 20 })
    const { state, wrapper } = setup()
    await flushPromises()
    state.page.value = 2
    await nextTick()
    expect(mocks.browse).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, pageSize: 20 }))
    wrapper.unmount()
  })
})

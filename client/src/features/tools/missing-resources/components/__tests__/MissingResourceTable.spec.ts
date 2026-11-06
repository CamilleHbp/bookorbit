import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { MissingBookEntry } from '@bookorbit/types'
import MissingResourceTable from '../MissingResourceTable.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

function book(id: number): MissingBookEntry {
  return {
    id,
    title: `Book ${id}`,
    authors: [],
    folderPath: `Book ${id}`,
    formats: [],
    libraryId: 1,
    libraryName: 'Main',
  } as unknown as MissingBookEntry
}

function render(props: { selectedIds?: Set<number>; selectAllMatching?: boolean } = {}) {
  return mount(MissingResourceTable, {
    props: {
      category: 'missing_books',
      items: [book(1), book(2), book(3), book(4)],
      selectedIds: new Set<number>(),
      selectAllMatching: false,
      allOnPageSelected: false,
      disabled: false,
      ...props,
    },
  })
}

function rowCheckboxes(wrapper: ReturnType<typeof render>) {
  return wrapper.findAll('ul input[type="checkbox"]')
}

describe('MissingResourceTable selection', () => {
  it('selects the range between the last clicked row and a Shift-clicked one', async () => {
    const wrapper = render()

    await rowCheckboxes(wrapper)[3]!.trigger('click')
    await rowCheckboxes(wrapper)[1]!.trigger('click', { shiftKey: true })

    expect(wrapper.emitted('setSelection')).toEqual([
      [[4], true],
      [[2, 3, 4], true],
    ])
  })

  it('toggles a row on Ctrl-click outside its checkbox', async () => {
    const wrapper = render({ selectedIds: new Set([2]) })

    await wrapper.findAll('ul li')[1]!.find('p').trigger('click', { ctrlKey: true })

    expect(wrapper.emitted('setSelection')).toEqual([[[2], false]])
  })

  it('keeps the plain toggle while every matching row is selected', async () => {
    const wrapper = render({ selectAllMatching: true })

    await rowCheckboxes(wrapper)[2]!.trigger('click', { shiftKey: true })

    expect(wrapper.emitted('toggle')).toEqual([[3]])
    expect(wrapper.emitted('setSelection')).toBeUndefined()
  })

  it('selects the page on Ctrl+A and clears on Escape', async () => {
    const wrapper = render({ selectedIds: new Set([1]) })

    await rowCheckboxes(wrapper)[0]!.trigger('keydown', { key: 'a', ctrlKey: true })
    await rowCheckboxes(wrapper)[0]!.trigger('keydown', { key: 'Escape' })

    expect(wrapper.emitted('setSelection')).toEqual([[[1, 2, 3, 4], true]])
    expect(wrapper.emitted('clearSelection')).toHaveLength(1)
  })
})

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { AnnotationItem } from '@bookorbit/types'
import AnnotationEntry from '../shared/AnnotationEntry.vue'

const annotation: AnnotationItem = {
  id: 7,
  bookId: 5,
  cfi: 'epubcfi(/6/4!/4/2/1:0)',
  jumpFileId: 9,
  pageno: 3,
  text: 'a short highlight',
  color: '#FACC15',
  style: 'highlight',
  note: null,
  chapterTitle: 'Chapter 1',
  origin: 'web',
  positionStatus: 'exact',
  chapterIndex: 0,
  highlightedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
}

function mountEntry(props: { selected?: boolean; selecting?: boolean } = {}) {
  return mount(AnnotationEntry, {
    props: {
      annotation,
      stacked: false,
      selected: false,
      selecting: false,
      active: false,
      compact: false,
      trashed: false,
      showDay: true,
      showBook: false,
      showChapter: true,
      ...props,
    },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  })
}

describe('AnnotationEntry selection', () => {
  it('reports Shift on the select box as a range extension', async () => {
    const wrapper = mountEntry({ selecting: true })
    await wrapper.get('button[aria-pressed]').trigger('click', { shiftKey: true })

    expect(wrapper.emitted('toggleSelect')).toEqual([[{ id: 7, selected: true, extend: true }]])
    expect(wrapper.emitted('open')).toBeUndefined()
  })

  it('selects on a modified row click and opens on a plain one', async () => {
    const wrapper = mountEntry({ selected: true, selecting: true })
    const quote = wrapper.get('p')

    await quote.trigger('click', { metaKey: true })
    await quote.trigger('click', { shiftKey: true })
    await quote.trigger('click')

    expect(wrapper.emitted('toggleSelect')).toEqual([[{ id: 7, selected: false, extend: false }], [{ id: 7, selected: false, extend: true }]])
    expect(wrapper.emitted('open')).toEqual([[7]])
  })
})

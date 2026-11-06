import { computed, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { AnnotationItem, BookDetail } from '@bookorbit/types'
import { useAnnotationSelection } from '@/features/annotations/composables/useAnnotationSelection'
import HighlightsTab from '../HighlightsTab.vue'

function highlight(id: number, chapterTitle: string): AnnotationItem {
  return {
    id,
    bookId: 5,
    cfi: null,
    jumpFileId: null,
    pageno: null,
    text: `highlight ${id}`,
    color: '#FACC15',
    style: 'highlight',
    note: null,
    chapterTitle,
    origin: 'web',
    positionStatus: 'exact',
    chapterIndex: 0,
    highlightedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  } as AnnotationItem
}

const hl = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('@/features/book/composables/useBookHighlights', () => ({ useBookHighlights: () => hl.current }))
vi.mock('@vueuse/core', async (importOriginal) => ({ ...(await importOriginal<object>()), useMediaQuery: () => ref(true) }))

function fakeHighlights() {
  const items = ref([highlight(1, 'One'), highlight(2, 'Two'), highlight(3, 'One'), highlight(4, 'Two')])
  const selection = useAnnotationSelection(items)
  const streamGroups = computed(() => [
    { key: 'One', mode: 'chapter', label: 'One', total: 2, items: items.value.filter((item) => item.chapterTitle === 'One') },
    { key: 'Two', mode: 'chapter', label: 'Two', total: 2, items: items.value.filter((item) => item.chapterTitle === 'Two') },
  ])
  return {
    items,
    streamGroups,
    error: ref(null),
    loading: ref(false),
    loadingMore: ref(false),
    hasMore: ref(false),
    total: ref(4),
    hasActiveFilters: ref(false),
    search: ref(''),
    colors: ref([]),
    dateFrom: ref(''),
    dateTo: ref(''),
    chapter: ref(null),
    view: ref('chapter'),
    groupMode: ref('chapter'),
    onlyNotes: ref(false),
    onlyNeedsReview: ref(false),
    noteCount: ref(0),
    needsReviewCount: ref(0),
    stats: ref(null),
    chapterGroups: ref([]),
    activeId: ref(null),
    activeItem: ref(null),
    selectedIds: selection.selectedIds,
    selectRange: selection.selectRange,
    selectAllOnPage: selection.selectAllOnPage,
    clearSelection: selection.clearSelection,
    toggleSelected: selection.toggleSelected,
    closeInspector: vi.fn<() => void>(),
    openInspector: vi.fn<(id: number) => void>(),
    stepInspector: vi.fn<(delta: number) => void>(),
    fetchHighlights: vi.fn<() => Promise<void>>(async () => undefined),
  }
}

describe('HighlightsTab selection', () => {
  it('Shift-selects in the grouped display order, selects all with Cmd+A and clears with Escape', async () => {
    const fake = fakeHighlights()
    hl.current = fake
    const wrapper = mount(HighlightsTab, {
      props: { book: { id: 5, title: 'Book', files: [] } as unknown as BookDetail },
      global: { stubs: { RouterLink: true, HighlightsSideRail: true, AnnotationEntryDetail: true, AnnotationGroupRule: true } },
      attachTo: document.body,
    })
    await flushPromises()

    const quotes = () => wrapper.findAll('article p')
    expect(quotes().map((quote) => quote.text())).toEqual(['highlight 1', 'highlight 3', 'highlight 2', 'highlight 4'])

    await quotes()[1]!.trigger('click', { metaKey: true })
    await quotes()[3]!.trigger('click', { shiftKey: true })
    expect([...fake.selectedIds.value].sort()).toEqual([2, 3, 4])

    await wrapper.get('section').trigger('keydown', { key: 'a', ctrlKey: true })
    expect(fake.selectedIds.value.size).toBe(4)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(fake.selectedIds.value.size).toBe(0)
    wrapper.unmount()
  })
})

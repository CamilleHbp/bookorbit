import { describe, it, expect } from 'vitest'
import { nextTick, ref } from 'vue'
import { useAnnotationSelection } from '../useAnnotationSelection'

describe('useAnnotationSelection', () => {
  it('toggles, selects the page, clears, and reports state', () => {
    const items = ref([{ id: 1 }, { id: 2 }, { id: 3 }])
    const selection = useAnnotationSelection(items)

    expect(selection.hasSelection.value).toBe(false)

    selection.toggleSelected(1)
    expect(selection.selectedIds.value.has(1)).toBe(true)
    expect(selection.hasSelection.value).toBe(true)

    selection.toggleSelected(1)
    expect(selection.selectedIds.value.has(1)).toBe(false)

    selection.selectAllOnPage()
    expect(selection.allVisibleSelected.value).toBe(true)
    expect(selection.selectedItems.value).toHaveLength(3)

    selection.clearSelection()
    expect(selection.hasSelection.value).toBe(false)
  })

  it('prunes selected ids that leave the list', async () => {
    const items = ref([{ id: 1 }, { id: 2 }])
    const selection = useAnnotationSelection(items)

    selection.selectAllOnPage()
    expect(selection.selectedIds.value.size).toBe(2)

    items.value = [{ id: 1 }]
    await nextTick()

    expect(selection.selectedIds.value.has(2)).toBe(false)
    expect(selection.selectedIds.value.size).toBe(1)
  })

  it('reports allVisibleSelected as false for an empty list', () => {
    const items = ref<{ id: number }[]>([])
    const selection = useAnnotationSelection(items)

    expect(selection.allVisibleSelected.value).toBe(false)
    selection.selectAllOnPage()
    expect(selection.hasSelection.value).toBe(false)
  })

  it('applies a Shift range in the display order it is given, not the load order', () => {
    const items = ref([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
    const selection = useAnnotationSelection(items)
    const displayOrder = [3, 1, 4, 2]

    selection.selectRange({ id: 3, selected: true, extend: false }, displayOrder)
    selection.selectRange({ id: 4, selected: true, extend: true }, displayOrder)
    expect([...selection.selectedIds.value].sort()).toEqual([1, 3, 4])

    selection.selectRange({ id: 1, selected: false, extend: true }, displayOrder)
    expect([...selection.selectedIds.value]).toEqual([3])
  })

  it('forgets the range anchor when the selection is cleared', () => {
    const items = ref([{ id: 1 }, { id: 2 }, { id: 3 }])
    const selection = useAnnotationSelection(items)

    selection.selectRange({ id: 1, selected: true, extend: false }, [1, 2, 3])
    selection.clearSelection()
    selection.selectRange({ id: 3, selected: true, extend: true }, [1, 2, 3])

    expect([...selection.selectedIds.value]).toEqual([3])
  })
})

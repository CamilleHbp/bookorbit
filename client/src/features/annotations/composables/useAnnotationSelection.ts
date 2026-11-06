import { computed, ref, watch, type Ref } from 'vue'
import { useRangeSelection } from '@/composables/useRangeSelection'

/** Shared bulk-selection state for an annotation list. Prunes ids that leave the list. */
export function useAnnotationSelection<T extends { id: number }>(items: Ref<T[]>) {
  const selectedIds = ref<Set<number>>(new Set())
  const range = useRangeSelection<number>()

  const visibleIds = computed(() => items.value.map((item) => item.id))
  const hasSelection = computed(() => selectedIds.value.size > 0)
  const allVisibleSelected = computed(() => visibleIds.value.length > 0 && visibleIds.value.every((id) => selectedIds.value.has(id)))
  const selectedItems = computed(() => items.value.filter((item) => selectedIds.value.has(item.id)))

  function toggleSelected(id: number) {
    const next = new Set(selectedIds.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selectedIds.value = next
  }

  function setSelected(ids: readonly number[], value: boolean) {
    const next = new Set(selectedIds.value)
    for (const id of ids) {
      if (value) next.add(id)
      else next.delete(id)
    }
    selectedIds.value = next
  }

  /** `orderedIds` is the display order, so a Shift range covers exactly the rows between the two clicks. */
  function selectRange(change: { id: number; selected: boolean; extend: boolean }, orderedIds: readonly number[]) {
    setSelected(range.targets(change.id, orderedIds, change.extend), change.selected)
  }

  function selectAllOnPage() {
    const next = new Set(selectedIds.value)
    for (const id of visibleIds.value) next.add(id)
    selectedIds.value = next
  }

  function clearSelection() {
    range.reset()
    if (selectedIds.value.size > 0) selectedIds.value = new Set()
  }

  watch(items, (nextItems) => {
    const currentIds = new Set(nextItems.map((item) => item.id))
    const pruned = new Set([...selectedIds.value].filter((id) => currentIds.has(id)))
    if (pruned.size !== selectedIds.value.size) selectedIds.value = pruned
  })

  return { selectedIds, hasSelection, allVisibleSelected, selectedItems, toggleSelected, selectRange, selectAllOnPage, clearSelection }
}

import { computed, ref } from 'vue'

export function useFanfictionPagination() {
  const cursors = ref<(string | null)[]>([])
  const number = ref(1)
  const canPrevious = computed(() => cursors.value.length > 0)

  function reset() {
    cursors.value = []
    number.value = 1
  }
  function advance(cursor: string | null) {
    // Retain cursor tokens only, with a bounded return history for very large libraries.
    cursors.value = [...cursors.value, cursor].slice(-200)
    number.value++
  }
  function retreat() {
    cursors.value.pop()
    number.value--
  }
  function previous() {
    return cursors.value.at(-1) ?? null
  }
  return { number, canPrevious, reset, advance, retreat, previous }
}

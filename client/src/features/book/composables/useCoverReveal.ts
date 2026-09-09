import { computed, ref, watch, type Ref } from 'vue'
import { useDisplaySettings } from '@/composables/useDisplaySettings'

export function useCoverReveal(bookId: Ref<number | undefined>, sensitiveCover: Ref<boolean | undefined>, visible: Ref<boolean> = ref(true)) {
  const { hideSensitiveCovers } = useDisplaySettings()
  const coverRevealed = ref(false)
  const canRevealCover = computed(() => hideSensitiveCovers.value && sensitiveCover.value === true)
  watch(
    [bookId, sensitiveCover, hideSensitiveCovers, visible],
    () => {
      coverRevealed.value = false
    },
    { flush: 'sync' },
  )
  function toggleCoverReveal() {
    coverRevealed.value = !coverRevealed.value
  }
  return { coverRevealed, canRevealCover, toggleCoverReveal }
}

import { describe, expect, it } from 'vitest'
import { effectScope, ref } from 'vue'
import { useDisplaySettings } from '@/composables/useDisplaySettings'
import { useCoverReveal } from '../useCoverReveal'
import { useCoverVersions } from '../useCoverVersions'

describe('sensitive cover visibility', () => {
  it('isolates hidden requests and resets the selected preview on navigation or close', () => {
    const { hideSensitiveCovers } = useDisplaySettings()
    hideSensitiveCovers.value = true
    const { coverUrl } = useCoverVersions()
    const scope = effectScope()
    const id = ref<number | undefined>(42)
    const sensitive = ref<boolean | undefined>(true)
    const visible = ref(true)
    const state = scope.run(() => useCoverReveal(id, sensitive, visible))!
    expect(coverUrl(42, 'cover', 123)).toBe('/api/v1/books/42/cover?t=123&hideSensitive=true')
    expect(state.canRevealCover.value).toBe(true)
    state.toggleCoverReveal()
    expect(coverUrl(42, 'cover', 123, state.coverRevealed.value)).toBe('/api/v1/books/42/cover?t=123')
    expect(coverUrl(42)).toContain('hideSensitive=true')
    id.value = 43
    expect(state.coverRevealed.value).toBe(false)
    state.toggleCoverReveal()
    hideSensitiveCovers.value = false
    expect(state.coverRevealed.value).toBe(false)
    expect(state.canRevealCover.value).toBe(false)
    hideSensitiveCovers.value = true
    expect(state.coverRevealed.value).toBe(false)
    state.toggleCoverReveal()
    visible.value = false
    expect(state.coverRevealed.value).toBe(false)
    visible.value = true
    expect(state.coverRevealed.value).toBe(false)
    sensitive.value = false
    expect(state.canRevealCover.value).toBe(false)
    scope.stop()
    hideSensitiveCovers.value = false
  })
})

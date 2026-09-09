import { effectScope, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useInlineSourceSettings } from './useInlineSourceSettings'
import { sourcePresetForUrl } from '../lib/source-presets'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))

describe('source setup while adding stories', () => {
  it('detects the pasted site and clears unsaved settings when changing libraries', async () => {
    const scope = effectScope()
    try {
      const library = ref<number | null>(5)
      const urls = ref('https://fiction.live/stories/Example/17CharacterIDhere/home')
      const state = scope.run(() => useInlineSourceSettings(library, ref([]), ref(''), urls))!
      state.addSource()
      expect(state.sourceSettings.libraryId).toBe(5)
      expect(state.sourceSettings.section).toBe('fiction.live')
      expect(state.sourceSettings.showEditor).toBe(true)
      state.sourceSettings.password = 'unsaved-secret'
      library.value = 6
      await nextTick()
      expect(state.sourceSettings.libraryId).toBe(6)
      expect(state.sourceSettings.password).toBe('')
      expect(state.sourceSettings.showEditor).toBe(false)
      expect(urls.value).toContain('fiction.live')
    } finally {
      scope.stop()
    }
  })

  it('does not suggest a trusted site preset for lookalike domains or unsafe URLs', () => {
    for (const url of ['https://fiction.live.example.org/story', 'https://fiction.live@evil.example/story', 'file:///fiction.live', 'invalid']) {
      expect(sourcePresetForUrl(url)).toBeUndefined()
    }
    expect(sourcePresetForUrl('https://beta.fiction.live/stories/example/id')?.id).toBe('fictionlive')
  })
})

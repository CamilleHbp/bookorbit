import { computed, reactive, watch, type Ref } from 'vue'
import type { FanfictionProfileSummary } from '@bookorbit/types'
import { useFanfictionSettings } from './useFanfictionSettings'
import { sourcePresetForUrl } from '../lib/source-presets'

export function useInlineSourceSettings(
  libraryId: Ref<number | null>,
  profiles: Ref<FanfictionProfileSummary[]>,
  profileId: Ref<string>,
  urls: Ref<string>,
) {
  const sourceSettings = reactive(useFanfictionSettings())
  const detectedSite = computed(() => sourcePresetForUrl(urls.value.split(/\r?\n/).find((line) => line.trim()) ?? ''))
  const selectedProfile = computed(() => profiles.value.find((profile) => profile.id === profileId.value))
  watch(
    libraryId,
    (value) => {
      sourceSettings.setLibrary(value)
    },
    { immediate: true },
  )
  function addSource() {
    sourceSettings.newProfile()
    if (detectedSite.value) {
      sourceSettings.presetId = detectedSite.value.id
      sourceSettings.applyPreset()
    }
  }
  function chooseSource(id: string) {
    sourceSettings.newProfile()
    sourceSettings.presetId = id
    sourceSettings.applyPreset()
  }
  function editSource() {
    if (selectedProfile.value) void sourceSettings.editProfile(selectedProfile.value)
  }
  return { sourceSettings, detectedSite, selectedProfile, addSource, chooseSource, editSource }
}

import { computed, onScopeDispose, reactive, ref, watch, type Ref } from 'vue'
import type { FanfictionProfileMatch, FanfictionProfileSummary, FanfictionSource } from '@bookorbit/types'
import { useFanfictionSettings } from './useFanfictionSettings'
import { api } from '@/lib/api'
import { sourcePresetForUrl } from '../lib/source-presets'

export function useInlineSourceSettings(
  libraryId: Ref<number | null>,
  profiles: Ref<FanfictionProfileSummary[]>,
  profileId: Ref<string>,
  urls: Ref<string>,
) {
  const sourceSettings = reactive(useFanfictionSettings())
  const repairingSource = ref<FanfictionSource | null>(null)
  const repairing = ref(false)
  let repairGeneration = 0
  onScopeDispose(() => {
    repairGeneration++
  })
  const detectedSite = computed(() => sourcePresetForUrl(urls.value.split(/\r?\n/).find((line) => line.trim()) ?? ''))
  const selectedProfile = computed(() => profiles.value.find((profile) => profile.id === profileId.value))
  watch(
    libraryId,
    (value) => {
      repairGeneration++
      repairingSource.value = null
      repairing.value = false
      sourceSettings.setLibrary(value)
    },
    { immediate: true },
  )
  function addSource(value?: string) {
    repairingSource.value = null
    sourceSettings.newProfile()
    const site = sourcePresetForUrl(value ?? urls.value.split(/\r?\n/).find((line) => line.trim()) ?? '')
    if (site) {
      sourceSettings.presetId = site.id
      sourceSettings.applyPreset()
    } else {
      try {
        const host = new URL(value ?? urls.value.trim()).hostname
        sourceSettings.name = host
        sourceSettings.section = host
        sourceSettings.configuration = `[${host}]\n`
      } catch {
        /* The URL field reports invalid input. */
      }
    }
  }
  function chooseSource(id: string) {
    repairingSource.value = null
    sourceSettings.newProfile()
    sourceSettings.presetId = id
    sourceSettings.applyPreset()
  }
  function cancelStoryLogin() {
    repairGeneration++
    if (repairing.value || repairingSource.value) sourceSettings.setLibrary(libraryId.value)
    repairing.value = false
    repairingSource.value = null
  }
  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await api(path, options)
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body.message === 'string' ? body.message : `HTTP ${response.status}`)
    return body as T
  }
  async function editStoryLogin(id: string) {
    const library = libraryId.value
    if (library === null || repairing.value || sourceSettings.busy) return
    const generation = ++repairGeneration
    const base = `/api/v1/libraries/${library}/fanfiction`
    repairing.value = true
    repairingSource.value = null
    sourceSettings.closeEditor()
    sourceSettings.error = ''
    try {
      const source = await request<FanfictionSource>(`${base}/sources/${id}`)
      if (generation !== repairGeneration) return
      const profile = source.profileId
        ? { id: source.profileId }
        : (await request<FanfictionProfileMatch>(`${base}/profile-match?url=${encodeURIComponent(source.canonicalUrl)}`)).profile
      if (generation !== repairGeneration) return
      if (profile) await sourceSettings.editProfile(profile)
      else addSource(source.canonicalUrl)
      if (generation !== repairGeneration) return
      // A shared profile can contain multiple websites. Edit this story's credentials.
      if (sourceSettings.showEditor) {
        sourceSettings.section = sourcePresetForUrl(source.canonicalUrl)?.section ?? source.site
        sourceSettings.readSection()
        repairingSource.value = source
      }
    } catch (failure) {
      if (generation === repairGeneration) sourceSettings.error = failure instanceof Error ? failure.message : 'Request failed'
    } finally {
      if (generation === repairGeneration) repairing.value = false
    }
  }
  function editSource() {
    repairingSource.value = null
    if (selectedProfile.value) void sourceSettings.editProfile(selectedProfile.value)
  }
  return {
    sourceSettings,
    detectedSite,
    selectedProfile,
    addSource,
    chooseSource,
    editSource,
    repairingSource,
    repairing,
    editStoryLogin,
    cancelStoryLogin,
  }
}

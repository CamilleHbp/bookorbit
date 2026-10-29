import { computed, onActivated, onUnmounted, ref, watch } from 'vue'
import { DEFAULT_TAG_GROUPING, MAX_TAG_SEPARATOR_LENGTH, type TagGroupingPreferences, type TagPrefixGroup } from '@bookorbit/types'
import { useAuth } from '@/features/auth/composables/useAuth'
import { browseTagGroups, saveTagGrouping } from '../../api/entity-manager'

import { browseReaderTagGroups } from '@/features/tags/api/tags'

export function useTagGroups(reader = false) {
  const { user } = useAuth()
  const stored = user.value?.settings.tagGrouping
  const validSeparator = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= MAX_TAG_SEPARATOR_LENGTH && !/[\s\p{Cc}]/u.test(value)
  const preferences = ref<TagGroupingPreferences>({
    enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : DEFAULT_TAG_GROUPING.enabled,
    separator: validSeparator(stored?.separator) ? stored.separator : DEFAULT_TAG_GROUPING.separator,
  })
  const separatorDraft = ref(preferences.value.separator)
  const enabledDraft = ref(preferences.value.enabled)
  const selectedPrefix = ref<string>()
  const search = ref('')
  const page = ref(1)
  const groups = ref<TagPrefixGroup[]>([])
  const total = ref(0)
  const loading = ref(false)
  const loadError = ref(false)
  const saveError = ref(false)
  const saving = ref(false)
  const pageSize = 20
  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
  const valid = computed(() => validSeparator(separatorDraft.value))
  const changed = computed(() => separatorDraft.value !== preferences.value.separator || enabledDraft.value !== preferences.value.enabled)
  let requestId = 0
  let debounce: ReturnType<typeof setTimeout> | undefined

  async function refresh(): Promise<void> {
    const request = ++requestId
    if (!preferences.value.enabled) {
      loading.value = false
      return
    }
    loading.value = true
    loadError.value = false
    try {
      const result = await (reader ? browseReaderTagGroups : browseTagGroups)({
        separator: preferences.value.separator,
        search: search.value || undefined,
        page: page.value,
        pageSize,
      })
      if (request !== requestId) return
      groups.value = result.items
      total.value = result.total
      if (page.value > totalPages.value) {
        page.value = totalPages.value
        return
      }
    } catch {
      if (request === requestId) loadError.value = true
    } finally {
      if (request === requestId) loading.value = false
    }
  }

  async function save(): Promise<void> {
    if (!valid.value || saving.value || !changed.value) return
    saving.value = true
    saveError.value = false
    const next = { enabled: enabledDraft.value, separator: separatorDraft.value }
    try {
      await saveTagGrouping(next)
      if (user.value) user.value.settings = { ...user.value.settings, tagGrouping: next }
      selectedPrefix.value = undefined
      preferences.value = next
      page.value = 1
    } catch {
      saveError.value = true
    } finally {
      saving.value = false
    }
  }

  watch(
    () => user.value?.settings.tagGrouping,
    (next) => {
      if (!next || !validSeparator(next.separator) || typeof next.enabled !== 'boolean') return
      if (next.separator === preferences.value.separator && next.enabled === preferences.value.enabled) return
      preferences.value = { ...next }
      separatorDraft.value = next.separator
      enabledDraft.value = next.enabled
      selectedPrefix.value = undefined
      page.value = 1
    },
  )
  let activated = false
  onActivated(() => {
    if (activated) void refresh()
    activated = true
  })
  watch([preferences, page], refresh, { immediate: true })
  watch(search, () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      if (page.value === 1) void refresh()
      else page.value = 1
    }, 300)
  })
  onUnmounted(() => {
    clearTimeout(debounce)
    requestId += 1
  })

  return {
    preferences,
    separatorDraft,
    enabledDraft,
    selectedPrefix,
    search,
    page,
    groups,
    total,
    loading,
    loadError,
    saveError,
    saving,
    totalPages,
    valid,
    changed,
    refresh,
    save,
  }
}

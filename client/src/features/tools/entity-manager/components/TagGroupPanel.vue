<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronLeft, ChevronRight, Folder, Search } from '@lucide/vue'
import { MAX_TAG_SEPARATOR_LENGTH } from '@bookorbit/types'
import { useTagGroups } from '../composables/useTagGroups'

const props = defineProps<{ revision: number; prefix?: string; reader?: boolean; compact?: boolean }>()
const emit = defineEmits<{ filter: [separator: string | undefined, prefix: string | undefined] }>()
const { t } = useI18n()
const id = useId()
const groups = useTagGroups(props.reader)
const expanded = ref(false)
const disclosure = ref<HTMLButtonElement | null>(null)
groups.selectedPrefix.value = props.prefix
watch(
  () => props.prefix,
  (value) => {
    groups.selectedPrefix.value = value
  },
)
const selectedLabel = computed(() =>
  groups.selectedPrefix.value === undefined ? t('tools.tagManager.allTags') : groups.selectedPrefix.value || t('tools.tagManager.ungrouped'),
)
const example = computed(() => `topic${groups.separatorDraft.value || '.'}fantasy`)
const canSave = computed(() => groups.valid.value && groups.changed.value && !groups.saving.value)

watch(
  [groups.preferences, groups.selectedPrefix],
  () => {
    emit(
      'filter',
      groups.preferences.value.enabled ? groups.preferences.value.separator : undefined,
      groups.preferences.value.enabled ? groups.selectedPrefix.value : undefined,
    )
  },
  { immediate: true },
)
watch(() => props.revision, groups.refresh)

function selectPrefix(prefix?: string): void {
  const wasExpanded = expanded.value
  groups.selectedPrefix.value = prefix
  expanded.value = false
  if (wasExpanded) void nextTick(() => disclosure.value?.focus())
}
function selectAll(): void {
  selectPrefix()
}
function selectUngrouped(): void {
  selectPrefix('')
}
function toggleExpanded(): void {
  expanded.value = !expanded.value
}
function previousPage(): void {
  groups.page.value -= 1
}
function nextPage(): void {
  groups.page.value += 1
}
</script>

<template>
  <aside
    :class="
      compact
        ? 'flex min-h-0 shrink-0 flex-col border-b border-border pb-2'
        : 'flex min-h-0 shrink-0 flex-col border-b border-border pb-3 md:w-56 md:border-b-0 md:border-e md:pe-4 md:pb-0'
    "
    :aria-label="t('tools.tagManager.groups')"
  >
    <button
      type="button"
      class="flex min-h-11 items-center justify-between gap-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :class="compact ? '' : 'md:hidden'"
      ref="disclosure"
      :aria-expanded="expanded"
      :aria-controls="id"
      @click="toggleExpanded"
    >
      <span class="truncate">{{ selectedLabel }}</span>
      <ChevronDown :size="16" aria-hidden="true" :class="expanded ? 'rotate-180' : ''" />
    </button>
    <div
      :id="id"
      class="min-h-0 flex-col gap-3"
      :class="[
        compact ? '' : 'md:flex',
        expanded ? (compact ? 'flex max-h-80 overflow-auto' : 'flex max-h-80 overflow-auto md:max-h-none') : 'hidden',
      ]"
    >
      <form class="space-y-2" @submit.prevent="groups.save">
        <label class="flex min-h-9 items-center gap-2 text-sm font-medium">
          <input v-model="groups.enabledDraft.value" type="checkbox" class="size-4 accent-primary" :disabled="groups.saving.value" />
          {{ t('tools.tagManager.groupByPrefix') }}
        </label>
        <div class="flex items-end gap-2">
          <div class="min-w-0 flex-1">
            <label :for="`${id}-separator`" class="mb-1 block text-xs text-muted-foreground">{{ t('tools.tagManager.separator') }}</label>
            <input
              :id="`${id}-separator`"
              v-model="groups.separatorDraft.value"
              :maxlength="MAX_TAG_SEPARATOR_LENGTH"
              :disabled="groups.saving.value"
              :aria-invalid="!groups.valid.value"
              :aria-describedby="`${id}-hint`"
              class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <button
            type="submit"
            class="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            :disabled="!canSave"
          >
            {{ groups.saving.value ? t('tools.tagManager.saving') : t('common.save') }}
          </button>
        </div>
        <p :id="`${id}-hint`" class="break-words text-xs text-muted-foreground">
          {{ groups.valid.value ? t('tools.tagManager.example', { example }) : t('tools.tagManager.invalidSeparator') }}
        </p>
        <p v-if="groups.saveError.value" role="alert" class="text-xs text-destructive">{{ t('tools.tagManager.saveError') }}</p>
      </form>
      <template v-if="groups.preferences.value.enabled">
        <nav class="space-y-1" :aria-label="t('tools.tagManager.groups')">
          <button
            type="button"
            class="min-h-9 w-full rounded-md px-2 text-start text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :class="groups.selectedPrefix.value === undefined ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground'"
            :aria-current="groups.selectedPrefix.value === undefined ? 'true' : undefined"
            @click="selectAll"
          >
            {{ t('tools.tagManager.allTags') }}
          </button>
          <button
            type="button"
            class="min-h-9 w-full rounded-md px-2 text-start text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :class="groups.selectedPrefix.value === '' ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground'"
            :aria-current="groups.selectedPrefix.value === '' ? 'true' : undefined"
            @click="selectUngrouped"
          >
            {{ t('tools.tagManager.ungrouped') }}
          </button>
        </nav>
        <div class="relative">
          <Search :size="14" class="pointer-events-none absolute start-2.5 top-2.5 text-muted-foreground" aria-hidden="true" />
          <input
            v-model="groups.search.value"
            type="search"
            :aria-label="t('tools.tagManager.searchGroups')"
            :placeholder="t('tools.tagManager.searchGroups')"
            class="h-9 w-full rounded-md border border-input bg-background pe-2 ps-8 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div class="min-h-0 flex-1 overflow-auto" :aria-busy="groups.loading.value">
          <p v-if="groups.loading.value" role="status" class="p-2 text-xs text-muted-foreground">{{ t('common.loading') }}</p>
          <div v-else-if="groups.loadError.value" role="alert" class="space-y-2 p-2 text-sm">
            <p>{{ t('tools.tagManager.loadError') }}</p>
            <button type="button" class="text-primary underline underline-offset-4" @click="groups.refresh">{{ t('common.retry') }}</button>
          </div>
          <p v-else-if="!groups.groups.value.length" class="p-2 text-xs text-muted-foreground">
            {{ groups.search.value ? t('tools.tagManager.noMatchingGroups') : t('tools.tagManager.noGroups') }}
          </p>
          <nav v-else :aria-label="t('tools.tagManager.prefixes')" class="space-y-1">
            <button
              v-for="group in groups.groups.value"
              :key="group.prefix"
              type="button"
              class="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :class="groups.selectedPrefix.value === group.prefix ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground'"
              :aria-current="groups.selectedPrefix.value === group.prefix ? 'true' : undefined"
              :title="group.prefix"
              @click="selectPrefix(group.prefix)"
            >
              <Folder :size="15" class="shrink-0" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">{{ group.prefix }}</span>
              <span class="text-xs tabular-nums">{{ group.tagCount }}</span>
            </button>
          </nav>
        </div>
        <div v-if="groups.totalPages.value > 1" class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            class="grid size-9 place-items-center rounded-md hover:bg-accent disabled:opacity-40"
            :disabled="groups.page.value <= 1 || groups.loading.value"
            :aria-label="t('tools.tagManager.previousGroups')"
            @click="previousPage"
          >
            <ChevronLeft :size="16" aria-hidden="true" />
          </button>
          <span>{{ groups.page.value }} / {{ groups.totalPages.value }}</span>
          <button
            type="button"
            class="grid size-9 place-items-center rounded-md hover:bg-accent disabled:opacity-40"
            :disabled="groups.page.value >= groups.totalPages.value || groups.loading.value"
            :aria-label="t('tools.tagManager.nextGroups')"
            @click="nextPage"
          >
            <ChevronRight :size="16" aria-hidden="true" />
          </button>
        </div>
      </template>
    </div>
  </aside>
</template>

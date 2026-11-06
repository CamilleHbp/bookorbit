<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { isRowSelectionClick, preventShiftTextSelection } from '@/composables/useRangeSelection'
import type { MissingBookEntry } from '@bookorbit/types'

import { formatList } from '@/i18n/formatters'

const props = defineProps<{ entry: MissingBookEntry; selected: boolean; disabled: boolean }>()
const emit = defineEmits<{ toggle: [id: number, change: { selected: boolean; extend: boolean }] }>()

const { t } = useI18n()

const title = computed(() => props.entry.title ?? t('tools.missingResources.untitled'))

function handleToggle(event: MouseEvent): void {
  emit('toggle', props.entry.id, { selected: (event.target as HTMLInputElement).checked, extend: event.shiftKey })
}

function handleRowClick(event: MouseEvent): void {
  if (props.disabled || !isRowSelectionClick(event)) return
  emit('toggle', props.entry.id, { selected: !props.selected, extend: event.shiftKey })
}
</script>

<template>
  <li class="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-muted/30" @mousedown="preventShiftTextSelection" @click="handleRowClick">
    <input
      type="checkbox"
      class="mt-0.5 shrink-0 rounded-xs accent-primary"
      :checked="selected"
      :disabled="disabled"
      :aria-label="title"
      @click="handleToggle"
    />
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium text-foreground">{{ title }}</p>
      <p v-if="entry.authors.length > 0" class="truncate text-xs text-muted-foreground">{{ formatList(entry.authors) }}</p>
      <p class="truncate text-xs text-muted-foreground" :title="entry.folderPath">{{ entry.folderPath }}</p>
    </div>
    <div class="hidden shrink-0 items-center gap-2 sm:flex">
      <span
        v-for="format in entry.formats"
        :key="format"
        class="rounded-xs border border-border px-1.5 py-0.5 text-xs text-muted-foreground uppercase"
      >
        {{ format }}
      </span>
      <span class="text-xs text-muted-foreground">{{ entry.libraryName }}</span>
    </div>
  </li>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { isRowSelectionClick, preventShiftTextSelection } from '@/composables/useRangeSelection'
import type { BrokenCoverEntry, BrokenCoverSlot } from '@bookorbit/types'

import { formatList } from '@/i18n/formatters'

const props = defineProps<{ entry: BrokenCoverEntry; selected: boolean; disabled: boolean }>()
const emit = defineEmits<{ toggle: [id: number, change: { selected: boolean; extend: boolean }] }>()

const { t } = useI18n()

const title = computed(() => props.entry.title ?? t('tools.missingResources.untitled'))

const SLOT_LABEL_KEYS: Record<BrokenCoverSlot['medium'], Record<BrokenCoverSlot['source'], string>> = {
  ebook: { extracted: 'tools.missingResources.brokenSlot.ebookExtracted', custom: 'tools.missingResources.brokenSlot.ebookCustom' },
  audio: { extracted: 'tools.missingResources.brokenSlot.audioExtracted', custom: 'tools.missingResources.brokenSlot.audioCustom' },
}

// A cover the upgrade has not moved into a slot yet has no slot to name, so it keeps the plain source.
const badges = computed(() =>
  props.entry.slots.length > 0
    ? props.entry.slots.map((slot) => ({ key: slot.medium, label: t(SLOT_LABEL_KEYS[slot.medium][slot.source]) }))
    : [{ key: 'cover', label: t(`tools.missingResources.coverSource.${props.entry.coverSource}`) }],
)

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
      <ul class="mt-1 flex flex-wrap gap-1">
        <li v-for="badge in badges" :key="badge.key" class="rounded-xs border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
          {{ badge.label }}
        </li>
      </ul>
    </div>
    <span class="hidden shrink-0 text-xs text-muted-foreground sm:block">{{ entry.libraryName }}</span>
  </li>
</template>

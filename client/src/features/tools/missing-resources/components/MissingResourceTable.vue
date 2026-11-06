<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BrokenCoverEntry, MissingBookEntry, MissingResourceCategory, OrphanedCoverDirEntry } from '@bookorbit/types'

import { isSelectAllShortcut, useRangeSelection } from '@/composables/useRangeSelection'
import { entryId, type MissingResourceEntry } from '../../composables/useMissingResources'
import BrokenCoverRow from './BrokenCoverRow.vue'
import MissingBookRow from './MissingBookRow.vue'
import OrphanedCoverRow from './OrphanedCoverRow.vue'

const props = defineProps<{
  category: MissingResourceCategory
  items: MissingResourceEntry[]
  selectedIds: Set<number>
  selectAllMatching: boolean
  allOnPageSelected: boolean
  disabled: boolean
}>()
const emit = defineEmits<{
  toggle: [id: number]
  togglePage: []
  setSelection: [ids: number[], selected: boolean]
  clearSelection: []
}>()

const { t } = useI18n()

const missingBooks = computed(() => (props.category === 'missing_books' ? (props.items as MissingBookEntry[]) : []))
const brokenCovers = computed(() => (props.category === 'broken_covers' ? (props.items as BrokenCoverEntry[]) : []))
const orphanedDirs = computed(() => (props.category === 'orphaned_cover_dirs' ? (props.items as OrphanedCoverDirEntry[]) : []))

function isSelected(entry: MissingResourceEntry): boolean {
  return props.selectAllMatching || props.selectedIds.has(entryId(entry))
}

function handleTogglePage(): void {
  emit('togglePage')
}

const range = useRangeSelection<number>()

/** "All matching" is not a list of ids, so a click there keeps the plain toggle that leaves that mode. */
function handleToggle(id: number, { selected, extend }: { selected: boolean; extend: boolean }): void {
  if (props.selectAllMatching) {
    range.reset()
    emit('toggle', id)
    return
  }
  emit('setSelection', range.targets(id, props.items.map(entryId), extend), selected)
}

function handleKeydown(event: KeyboardEvent): void {
  if (props.disabled) return
  if (isSelectAllShortcut(event)) {
    event.preventDefault()
    if (!props.selectAllMatching) emit('setSelection', props.items.map(entryId), true)
  } else if (event.key === 'Escape' && (props.selectAllMatching || props.selectedIds.size > 0)) {
    event.preventDefault()
    emit('clearSelection')
  }
}
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-border" @keydown="handleKeydown">
    <div class="flex items-center gap-3 border-b border-border bg-muted/30 px-4 py-2.5">
      <label class="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          class="rounded-xs accent-primary"
          :checked="allOnPageSelected || selectAllMatching"
          :disabled="disabled || items.length === 0"
          @change="handleTogglePage"
        />
        <span>{{ t('tools.missingResources.table.selectPage') }}</span>
      </label>
    </div>

    <ul v-if="category === 'missing_books'" class="divide-y divide-border">
      <MissingBookRow
        v-for="entry in missingBooks"
        :key="entry.id"
        :entry="entry"
        :selected="isSelected(entry)"
        :disabled="disabled"
        @toggle="handleToggle"
      />
    </ul>

    <ul v-else-if="category === 'broken_covers'" class="divide-y divide-border">
      <BrokenCoverRow
        v-for="entry in brokenCovers"
        :key="entry.id"
        :entry="entry"
        :selected="isSelected(entry)"
        :disabled="disabled"
        @toggle="handleToggle"
      />
    </ul>

    <ul v-else class="divide-y divide-border">
      <OrphanedCoverRow
        v-for="entry in orphanedDirs"
        :key="entry.bookId"
        :entry="entry"
        :selected="isSelected(entry)"
        :disabled="disabled"
        @toggle="handleToggle"
      />
    </ul>
  </div>
</template>

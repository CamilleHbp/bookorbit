<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Trophy } from '@lucide/vue'
import PageTitleRow from '@/components/page-header/PageTitleRow.vue'
import type { FilterState } from '../types'

const { t } = useI18n()

const props = defineProps<{
  activeFilter: FilterState
  totalEarned: number
  totalAvailable: number
  earnedCount: number
  inProgressCount: number
  lockedCount: number
}>()

const emit = defineEmits<{
  change: [filter: FilterState]
}>()

function handleAll(): void {
  emit('change', 'all')
}

function handleEarned(): void {
  emit('change', 'earned')
}

function handleInProgress(): void {
  emit('change', 'in-progress')
}

function handleLocked(): void {
  emit('change', 'locked')
}

function pillClass(filter: FilterState): string {
  return props.activeFilter === filter
    ? 'bg-primary/15 text-foreground shadow-sm ring-1 ring-primary/20'
    : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
}
</script>

<template>
  <PageTitleRow :eyebrow="t('components.sidebar.zones.reading')" :title="t('achievements.title')" :icon="Trophy">
    <template #facts>
      <span class="tabular-nums">{{ t('achievements.tiersCount', { earned: totalEarned, total: totalAvailable }) }}</span>
    </template>
    <template #inline>
      <div class="-mx-1 overflow-x-auto px-1 pb-0.5 sm:mx-0 sm:px-0 sm:pb-0">
        <div class="inline-flex min-w-max items-center gap-1 rounded-lg bg-muted p-1">
          <button :class="['shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors', pillClass('all')]" @click="handleAll">
            {{ t('achievements.filter.all') }}
          </button>
          <button :class="['shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors', pillClass('earned')]" @click="handleEarned">
            {{ t('achievements.filter.earned', { count: earnedCount }) }}
          </button>
          <button
            :class="['shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors', pillClass('in-progress')]"
            @click="handleInProgress"
          >
            {{ t('achievements.filter.inProgress', { count: inProgressCount }) }}
          </button>
          <button :class="['shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors', pillClass('locked')]" @click="handleLocked">
            {{ t('achievements.filter.locked', { count: lockedCount }) }}
          </button>
        </div>
      </div>
    </template>
  </PageTitleRow>
</template>

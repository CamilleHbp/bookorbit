<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from '@lucide/vue'
import type { FanfictionActivity, FanfictionActivityKind, FanfictionActivitySummary } from '@bookorbit/types'
import { relativeTimestamp } from '@/lib/relative-time'
import FanfictionPagination from './FanfictionPagination.vue'

const props = defineProps<{
  items: FanfictionActivity[]
  summary: FanfictionActivitySummary | null
  kind: FanfictionActivityKind | ''
  page: number
  previous: boolean
  next: boolean
  busy: boolean
}>()
const emit = defineEmits<{ filter: [kind: FanfictionActivityKind | '']; previous: []; next: [] }>()
const { t, locale } = useI18n()

const storageKey = 'bookorbit.fanfiction.changeLogOpen'
function readOpen() {
  try {
    return localStorage.getItem(storageKey) === 'true'
  } catch {
    return false
  }
}
const open = ref(readOpen())
function handleToggle(event: Event) {
  open.value = (event.target as HTMLDetailsElement).open
  try {
    localStorage.setItem(storageKey, String(open.value))
  } catch {
    // Remembering the toggle is a convenience only.
  }
}

const kinds: FanfictionActivityKind[] = ['updated', 'imported', 'failed', 'attention', 'rolled_back', 'batch_completed']
const problemKinds = new Set<FanfictionActivityKind>(['failed', 'attention'])
const summaryParts = computed(() => {
  const summary = props.summary
  if (!summary) return []
  const parts: { key: string; text: string; problem: boolean }[] = []
  if (summary.updatedStories)
    parts.push({ key: 'updated', text: t('fanfiction.changeLog.updated', { count: summary.updatedStories }), problem: false })
  for (const kind of ['imported', 'failed', 'attention', 'rolled_back'] as const)
    if (summary.counts[kind])
      parts.push({ key: kind, text: t(`fanfiction.changeLog.${kind}`, { count: summary.counts[kind] }), problem: problemKinds.has(kind) })
  return parts
})

const dayFormat = computed(() => new Intl.DateTimeFormat(locale.value, { weekday: 'long', month: 'long', day: 'numeric' }))
function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}
function dayLabel(date: Date) {
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (dayKey(date) === dayKey(today)) return t('fanfiction.changeLog.today')
  if (dayKey(date) === dayKey(yesterday)) return t('fanfiction.changeLog.yesterday')
  return dayFormat.value.format(date)
}
const groups = computed(() => {
  const result: { key: string; label: string; items: (FanfictionActivity & { relative: string; full: string })[] }[] = []
  for (const item of props.items) {
    const date = new Date(item.createdAt)
    const key = dayKey(date)
    let group = result.at(-1)
    if (!group || group.key !== key) {
      group = { key, label: dayLabel(date), items: [] }
      result.push(group)
    }
    group.items.push({ ...item, relative: relativeTimestamp(date), full: date.toLocaleString() })
  }
  return result
})

function handleFilter(event: Event) {
  emit('filter', (event.target as HTMLSelectElement).value as FanfictionActivityKind | '')
}
function handlePrevious() {
  emit('previous')
}
function handleNext() {
  emit('next')
}
</script>

<template>
  <details class="group border-border rounded-xl border" :open="open" @toggle="handleToggle">
    <summary class="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
      <ChevronRight class="size-4 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
      <h2 class="text-base font-semibold">{{ t('fanfiction.recentChanges') }}</h2>
      <p v-if="summary" class="text-muted-foreground basis-full ps-7 text-sm sm:basis-auto sm:ps-0">
        <span class="text-foreground font-medium">{{ t('fanfiction.changeLog.lastDays') }}:</span>{{ ' ' }}
        <template v-if="summaryParts.length">
          <template v-for="(part, index) in summaryParts" :key="part.key"
            ><template v-if="index > 0"> · </template><span :class="{ 'text-destructive font-medium': part.problem }">{{ part.text }}</span></template
          >
        </template>
        <template v-else>{{ t('fanfiction.changeLog.none') }}</template>
      </p>
    </summary>
    <div class="border-border space-y-4 border-t px-4 pt-3 pb-4">
      <label class="flex flex-wrap items-center gap-2 text-sm">
        {{ t('fanfiction.changeLog.filter') }}
        <select
          :value="kind"
          :disabled="busy"
          class="border-input bg-background h-11 rounded-md border px-3 focus-visible:outline-2 focus-visible:outline-ring sm:h-9"
          @change="handleFilter"
        >
          <option value="">{{ t('fanfiction.changeLog.all') }}</option>
          <option v-for="option in kinds" :key="option" :value="option">{{ t(`fanfiction.activityKinds.${option}`) }}</option>
        </select>
      </label>
      <p v-if="!items.length" class="text-muted-foreground text-sm">
        {{ kind ? t('fanfiction.changeLog.emptyFiltered') : t('fanfiction.changeLog.empty') }}
      </p>
      <section v-for="group in groups" :key="group.key" :aria-label="group.label">
        <h3 class="text-muted-foreground pb-1 text-sm font-medium">{{ group.label }}</h3>
        <ul class="divide-border divide-y">
          <li v-for="event in group.items" :key="event.id" class="grid min-h-11 grid-cols-[0.5rem_1fr] items-center gap-x-3 py-2 sm:flex">
            <span
              class="size-2 rounded-full"
              :class="problemKinds.has(event.kind) ? 'bg-destructive' : event.kind === 'imported' ? 'bg-primary' : 'bg-muted-foreground/50'"
              aria-hidden="true"
            />
            <RouterLink
              v-if="event.bookId"
              :to="{ name: 'book-detail', params: { bookId: event.bookId } }"
              class="min-w-0 font-medium break-words underline decoration-border underline-offset-4 hover:decoration-current sm:flex-1 sm:truncate"
              >{{ event.title }}</RouterLink
            >
            <span v-else class="min-w-0 font-medium break-words sm:flex-1 sm:truncate">{{ event.title }}</span>
            <span class="col-start-2 flex shrink-0 gap-3 text-sm whitespace-nowrap">
              <span :class="problemKinds.has(event.kind) ? 'text-destructive' : 'text-muted-foreground'">{{
                t(`fanfiction.activityKinds.${event.kind}`)
              }}</span>
              <time :datetime="event.createdAt" :title="event.full" class="text-muted-foreground tabular-nums">{{ event.relative }}</time>
            </span>
          </li>
        </ul>
      </section>
      <FanfictionPagination
        :page="page"
        :previous="previous"
        :next="next"
        :busy="busy"
        :label="t('fanfiction.recentChanges')"
        :previous-label="t('fanfiction.changeLog.newer')"
        :next-label="t('fanfiction.changeLog.older')"
        @previous="handlePrevious"
        @next="handleNext"
      />
    </div>
  </details>
</template>

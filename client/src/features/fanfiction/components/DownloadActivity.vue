<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookCheck, BookOpen, CircleAlert, Clock3, Download, Radio, RefreshCw, RotateCw, WifiOff } from '@lucide/vue'
import type { FanfictionDownloadQueue } from '@bookorbit/types'

const props = defineProps<{ snapshot: FanfictionDownloadQueue; checkedAt?: Date; error?: boolean; busy?: boolean }>()
const emit = defineEmits<{ refresh: []; jump: [section: string] }>()
const { t, locale } = useI18n()
const counts = computed(() => props.snapshot.storyCounts ?? props.snapshot.totals)
const checked = computed(() => props.checkedAt?.toLocaleTimeString(locale.value, { hour: 'numeric', minute: '2-digit', second: '2-digit' }))
const summary = computed(() => {
  const { running, queued, retrying, attention } = counts.value
  const items = [
    {
      section: 'running',
      icon: Download,
      tone: 'bg-primary/10 text-primary',
      count: running,
      label: t('fanfiction.liveActivity.downloadingCount', { count: running }),
    },
    {
      section: 'queued',
      icon: Clock3,
      tone: 'bg-muted text-muted-foreground',
      count: queued,
      label: t('fanfiction.liveActivity.waitingCount', { count: queued }),
    },
  ]
  if (retrying)
    items.push({
      section: 'retrying',
      icon: RotateCw,
      tone: 'bg-info/10 text-info',
      count: retrying,
      label: `${t('fanfiction.downloads.retrying')} (${retrying})`,
    })
  if (attention)
    items.push({
      section: 'attention',
      icon: CircleAlert,
      tone: 'bg-warning/15 text-warning',
      count: attention,
      label: t('fanfiction.liveActivity.attentionCount', { count: attention }),
    })
  if (props.snapshot.recent.length)
    items.push({
      section: 'finished',
      icon: BookCheck,
      tone: 'bg-success/10 text-success',
      count: props.snapshot.recent.length,
      label: t('fanfiction.downloads.finished'),
    })
  return items
})
function refresh() {
  emit('refresh')
}
</script>
<template>
  <section class="rounded-xl border border-border bg-card px-3 py-3 text-card-foreground sm:p-5" :aria-label="t('fanfiction.liveActivity.title')">
    <header class="flex flex-wrap items-center justify-between gap-x-1 sm:gap-x-3">
      <h2 class="flex items-center gap-2 text-lg font-semibold">
        <BookOpen class="size-5 shrink-0 text-primary" aria-hidden="true" />{{ t('fanfiction.liveActivity.title') }}
      </h2>
      <div class="flex items-center gap-1 text-xs text-muted-foreground sm:text-sm">
        <span class="inline-flex items-center gap-1.5" role="status">
          <WifiOff v-if="error" class="size-4 shrink-0" aria-hidden="true" /><Radio v-else class="size-4 shrink-0 text-primary" aria-hidden="true" />
          {{ t(error ? 'fanfiction.liveActivity.disconnected' : 'fanfiction.liveActivity.live') }}
        </span>
        <button
          type="button"
          class="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
          :disabled="busy"
          :aria-label="t('fanfiction.refresh')"
          :title="t('fanfiction.refresh')"
          @click="refresh"
        >
          <RefreshCw class="size-4" :class="{ 'motion-safe:animate-spin': busy }" aria-hidden="true" />
        </button>
      </div>
    </header>
    <ul class="grid grid-cols-2 gap-x-2 text-sm tabular-nums sm:flex sm:flex-wrap sm:gap-x-6" aria-live="polite" aria-atomic="true">
      <li v-for="item in summary" :key="item.section" class="flex min-w-0 items-center">
        <button
          v-if="item.count"
          type="button"
          class="inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-sm sm:gap-2 text-start font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
          @click="emit('jump', item.section)"
        >
          <span class="inline-flex size-5 shrink-0 items-center justify-center sm:size-6 rounded-md" :class="item.tone">
            <component :is="item.icon" class="size-4" aria-hidden="true" />
          </span>
          <span class="underline decoration-muted-foreground/60 underline-offset-4">{{ item.label }}</span>
        </button>
        <span v-else class="inline-flex items-center gap-1.5 text-muted-foreground sm:gap-2">
          <span class="inline-flex size-5 shrink-0 items-center justify-center sm:size-6"
            ><component :is="item.icon" class="size-4" aria-hidden="true"
          /></span>
          {{ item.label }}
        </span>
      </li>
    </ul>
    <footer v-if="checked || $slots.default" class="mt-2 flex flex-wrap items-center justify-between gap-x-3 border-t border-border pt-2">
      <p v-if="checked" class="text-xs text-muted-foreground">{{ t('fanfiction.liveActivity.checked', { time: checked }) }}</p>
      <slot />
    </footer>
  </section>
</template>

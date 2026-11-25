<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Radio, RefreshCw, WifiOff } from '@lucide/vue'
import type { FanfictionDownloadQueue } from '@bookorbit/types'

const props = defineProps<{ snapshot: FanfictionDownloadQueue; checkedAt?: Date; error?: boolean; busy?: boolean }>()
const emit = defineEmits<{ refresh: []; jump: [section: string] }>()
const { t, locale } = useI18n()
const counts = computed(() => props.snapshot.storyCounts ?? props.snapshot.totals)
const checked = computed(() => props.checkedAt?.toLocaleTimeString(locale.value, { hour: 'numeric', minute: '2-digit', second: '2-digit' }))
const summary = computed(() => {
  const { running, queued, retrying, attention } = counts.value
  const items = [
    { section: 'running', count: running, label: t('fanfiction.liveActivity.downloadingCount', { count: running }) },
    { section: 'queued', count: queued, label: t('fanfiction.liveActivity.waitingCount', { count: queued }) },
  ]
  if (retrying) items.push({ section: 'retrying', count: retrying, label: `${t('fanfiction.downloads.retrying')} (${retrying})` })
  if (attention) items.push({ section: 'attention', count: attention, label: t('fanfiction.liveActivity.attentionCount', { count: attention }) })
  if (props.snapshot.recent.length)
    items.push({ section: 'finished', count: props.snapshot.recent.length, label: t('fanfiction.downloads.finished') })
  return items
})
function refresh() {
  emit('refresh')
}
</script>
<template>
  <section class="rounded-xl border border-border bg-card px-4 py-3 text-card-foreground sm:p-5" :aria-label="t('fanfiction.liveActivity.title')">
    <header class="flex flex-wrap items-center justify-between gap-x-3">
      <h2 class="text-lg font-semibold">{{ t('fanfiction.liveActivity.title') }}</h2>
      <div class="flex items-center gap-1 text-sm text-muted-foreground">
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
    <ul class="grid grid-cols-2 gap-x-3 text-sm tabular-nums sm:flex sm:flex-wrap sm:gap-x-6" aria-live="polite" aria-atomic="true">
      <li v-for="item in summary" :key="item.section" class="flex min-w-0 items-center">
        <button
          v-if="item.count"
          type="button"
          class="min-h-11 rounded-sm text-start font-medium underline decoration-muted-foreground/60 underline-offset-4 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
          @click="emit('jump', item.section)"
        >
          {{ item.label }}
        </button>
        <span v-else class="text-muted-foreground">{{ item.label }}</span>
      </li>
    </ul>
    <footer v-if="checked || $slots.default" class="mt-2 flex flex-wrap items-center justify-between gap-x-3 border-t border-border pt-2">
      <p v-if="checked" class="text-xs text-muted-foreground">{{ t('fanfiction.liveActivity.checked', { time: checked }) }}</p>
      <slot />
    </footer>
  </section>
</template>

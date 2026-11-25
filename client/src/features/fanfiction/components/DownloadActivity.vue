<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw, Radio, WifiOff } from '@lucide/vue'
import type { FanfictionDownloadQueue } from '@bookorbit/types'
const props = defineProps<{ snapshot: FanfictionDownloadQueue; checkedAt?: Date; error?: boolean; busy?: boolean }>()
const emit = defineEmits<{ refresh: []; jump: [section: string] }>()
const { t, locale } = useI18n()
const counts = computed(() => props.snapshot.storyCounts ?? props.snapshot.totals)
const waiting = computed(() => counts.value.queued + counts.value.retrying)
const checked = computed(() => props.checkedAt?.toLocaleTimeString(locale.value, { hour: 'numeric', minute: '2-digit', second: '2-digit' }))
const shortcuts = computed(() =>
  [
    { section: 'running', count: counts.value.running, label: t('fanfiction.liveActivity.downloadingCount', { count: counts.value.running }) },
    {
      section: counts.value.queued ? 'queued' : 'retrying',
      count: waiting.value,
      label: t('fanfiction.liveActivity.waitingCount', { count: waiting.value }),
    },
    { section: 'attention', count: counts.value.attention, label: t('fanfiction.liveActivity.attentionCount', { count: counts.value.attention }) },
    { section: 'finished', count: props.snapshot.recent.length, label: t('fanfiction.downloads.finished') },
  ].filter((item) => item.count),
)
function refresh() {
  emit('refresh')
}
</script>
<template>
  <section class="space-y-1" :aria-label="t('fanfiction.liveActivity.title')">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="font-semibold">{{ t('fanfiction.liveActivity.title') }}</h2>
      <div class="flex flex-wrap items-center justify-end gap-1 text-xs text-muted-foreground">
        <span class="inline-flex items-center gap-1.5" role="status"
          ><WifiOff v-if="error" class="size-4" aria-hidden="true" /><Radio v-else class="size-4 text-primary" aria-hidden="true" />{{
            t(error ? 'fanfiction.liveActivity.disconnected' : 'fanfiction.liveActivity.live')
          }}</span
        >

        <button
          type="button"
          class="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
          :disabled="busy"
          :aria-label="t('fanfiction.refresh')"
          @click="refresh"
        >
          <RefreshCw class="size-4" :class="{ 'motion-safe:animate-spin': busy }" aria-hidden="true" />
        </button>
      </div>
    </div>
    <ul v-if="shortcuts.length" class="flex flex-wrap items-center gap-x-4 text-sm">
      <li v-for="item in shortcuts" :key="item.section">
        <button
          type="button"
          class="min-h-11 font-medium underline decoration-border underline-offset-4 hover:decoration-current"
          @click="emit('jump', item.section)"
        >
          {{ item.label }}
        </button>
      </li>
    </ul>
    <p v-if="checked" class="text-xs text-muted-foreground">{{ t('fanfiction.liveActivity.checked', { time: checked }) }}</p>
  </section>
</template>

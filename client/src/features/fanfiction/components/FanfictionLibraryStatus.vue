<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { CircleCheck, CircleAlert, RefreshCw, LibraryBig, Clock3, BookUp2, BookCheck } from '@lucide/vue'
import type { FanfictionDownloadQueue, FanfictionJob, FanfictionSourceBatchStatus } from '@bookorbit/types'

const props = defineProps<{
  libraryId: number
  job?: FanfictionJob | null
  summary?: FanfictionSourceBatchStatus | null
  checking?: boolean
  totals?: FanfictionDownloadQueue['totals']
  stale?: boolean
  showActions?: boolean
}>()
const { t, locale } = useI18n()
const check = computed(() => (!['schedule', 'policy'].includes(props.job?.result?.selection?.action ?? '') ? props.job : null))
const tracked = computed(() => (check.value && props.summary?.trackingAvailable ? props.summary : null))
const checkDate = computed(() => {
  if (!check.value?.createdAt) return ''
  const date = new Date(check.value.createdAt)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' })
})
const status = computed(() => {
  if (props.stale) return 'unavailable'
  if (
    tracked.value?.needsAttention ||
    props.totals?.attention ||
    ['failed', 'configuration_blocked', 'review_required'].includes(check.value?.state ?? '')
  )
    return 'attention'
  if (!props.totals && !tracked.value) return 'unavailable'
  if (props.checking || props.totals?.running || props.totals?.queued || props.totals?.retrying) return 'active'
  return 'clear'
})
const icon = computed(() =>
  status.value === 'attention' || status.value === 'unavailable' ? CircleAlert : status.value === 'active' ? RefreshCw : CircleCheck,
)
const stats = computed(() =>
  tracked.value
    ? [
        { label: t('fanfiction.bulk.updated'), value: tracked.value.updated, icon: BookUp2, color: 'text-primary' },
        { label: t('fanfiction.bulk.unchanged'), value: tracked.value.unchanged, icon: BookCheck, color: 'text-muted-foreground' },
        {
          attention: true,
          label: t('fanfiction.bulk.attention'),
          value: tracked.value.needsAttention,
          icon: CircleAlert,
          color: tracked.value.needsAttention ? 'text-warning' : 'text-muted-foreground',
        },
      ]
    : [],
)
const sourcesLink = computed(() => ({ name: 'fanfiction', query: { libraryId: props.libraryId, tab: 'stories' } }))
const checkState = computed(() => {
  if (props.checking) return 'fanfiction.bulk.checking'
  if (check.value?.state === 'cancelled') return 'fanfiction.bulk.stopped'
  if (['failed', 'configuration_blocked'].includes(check.value?.state ?? '')) return 'fanfiction.bulk.interrupted'
  return 'fanfiction.libraryStatus.lastCheck'
})
const failuresOpen = ref(false)
const failuresPanel = ref<HTMLElement>()
const failuresId = useId()
const actionsVisible = computed(() =>
  Boolean(
    props.checking ||
    props.showActions ||
    ['failed', 'configuration_blocked', 'cancelled'].includes(check.value?.state ?? '') ||
    (!tracked.value && check.value) ||
    (failuresOpen.value && tracked.value?.needsAttention),
  ),
)
async function toggleFailures() {
  failuresOpen.value = !failuresOpen.value
  if (failuresOpen.value) {
    await nextTick()
    failuresPanel.value?.focus()
  }
}
watch([() => props.libraryId, () => props.job?.id], () => {
  failuresOpen.value = false
})
</script>

<template>
  <section class="rounded-xl border border-border bg-card text-card-foreground" :aria-label="t('fanfiction.libraryStatus.title')">
    <header class="flex flex-wrap items-center justify-between gap-3 rounded-t-xl border-b border-border bg-muted/30 px-5 py-4 sm:px-6">
      <h2 class="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
        <LibraryBig class="size-5 text-primary" aria-hidden="true" />{{ t('fanfiction.libraryStatus.title') }}
      </h2>
      <p
        class="flex items-center gap-2 rounded-md px-2.5 py-1 text-xs font-medium"
        :class="
          status === 'attention'
            ? 'bg-warning/15 text-foreground'
            : status === 'clear'
              ? 'bg-primary/10 text-foreground'
              : 'bg-muted text-muted-foreground'
        "
        role="status"
      >
        <component
          :is="icon"
          class="size-4 shrink-0"
          :class="status === 'attention' ? 'text-warning' : status === 'clear' ? 'text-primary' : ''"
          aria-hidden="true"
        />{{ t(`fanfiction.libraryStatus.${status}`) }}
      </p>
    </header>
    <div class="space-y-5 p-5 sm:p-6">
      <div class="grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div class="space-y-1">
          <p class="flex items-center gap-2 text-sm font-medium">
            <Clock3 class="size-4 text-muted-foreground" aria-hidden="true" />{{ t(checkState) }}
          </p>
          <time v-if="checkDate" :datetime="check?.createdAt" class="block text-sm text-muted-foreground sm:text-base">{{ checkDate }}</time>
          <p v-else class="text-sm text-muted-foreground">{{ t('fanfiction.libraryStatus.noCheck') }}</p>
          <p v-if="tracked" class="pt-2 text-sm tabular-nums text-muted-foreground">
            {{ t('fanfiction.bulk.checked', { count: tracked.checked, total: tracked.total ?? tracked.checked }) }}
          </p>
        </div>
        <dl v-if="stats.length" class="grid grid-cols-3 divide-x divide-border py-3 sm:min-w-80">
          <div v-for="stat in stats" :key="stat.label" class="flex flex-col gap-1 px-3 sm:px-4">
            <dt class="order-2 text-xs text-muted-foreground">{{ stat.label }}</dt>
            <dd class="flex min-h-11 items-center gap-2 text-2xl font-semibold tabular-nums">
              <button
                v-if="stat.attention && stat.value > 0"
                type="button"
                :aria-label="t('fanfiction.bulk.failures') + ': ' + stat.value"
                :aria-expanded="actionsVisible"
                :aria-controls="failuresId"
                class="inline-flex min-h-11 min-w-11 items-center gap-2 rounded-md text-start underline decoration-warning/40 underline-offset-4 hover:bg-warning/10 hover:decoration-current focus-visible:outline-2 focus-visible:outline-ring"
                @click="toggleFailures"
              >
                <component :is="stat.icon" class="size-4 shrink-0" :class="stat.color" aria-hidden="true" />{{ stat.value }}
              </button>
              <template v-else><component :is="stat.icon" class="size-4 shrink-0" :class="stat.color" aria-hidden="true" />{{ stat.value }}</template>
            </dd>
          </div>
        </dl>
      </div>
      <progress
        v-if="checking && tracked?.total"
        :value="tracked.checked"
        :max="tracked.total"
        :aria-label="t('fanfiction.bulk.libraryProgress')"
        class="block h-1.5 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary"
      />
      <section
        v-if="actionsVisible"
        :id="failuresId"
        ref="failuresPanel"
        tabindex="-1"
        :aria-label="t('fanfiction.bulk.title')"
        class="border-t border-border pt-4 focus:outline-none"
      >
        <slot />
      </section>
    </div>
    <footer class="border-t border-border px-5 py-1 sm:px-6">
      <RouterLink
        :to="sourcesLink"
        class="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground hover:underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
        ><LibraryBig class="size-4" aria-hidden="true" />{{ t('fanfiction.downloads.sources') }}</RouterLink
      >
    </footer>
  </section>
</template>

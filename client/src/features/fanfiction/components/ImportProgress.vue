<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleAlert, CircleCheck, LoaderCircle } from '@lucide/vue'
import type { FanfictionJob } from '@bookorbit/types'

const props = defineProps<{ job: FanfictionJob }>()
const { t, te } = useI18n()
const progress = computed(() => props.job.result?.progress)
const active = computed(() => ['queued', 'running'].includes(props.job.state))
const succeeded = computed(() => ['succeeded', 'no_change'].includes(props.job.state))
const failed = computed(() => ['failed', 'configuration_blocked', 'review_required'].includes(props.job.state))
const status = computed(() => {
  if (props.job.cancellationRequested && active.value) return t('fanfiction.progress.cancelling')
  if (props.job.state === 'queued' && props.job.attempts > 0) return t('fanfiction.progress.retrying')
  if (props.job.state === 'running' && (progress.value || ['import', 'preview'].includes(props.job.kind)))
    return t(`fanfiction.progress.${progress.value?.stage ?? 'metadata'}`)
  return t(`fanfiction.states.${props.job.state}`)
})
const chapterLabel = computed(() =>
  progress.value?.totalChapters
    ? t('fanfiction.progress.chapters', { completed: progress.value.completedChapters ?? 0, total: progress.value.totalChapters })
    : '',
)
const percentage = computed(() => {
  if (succeeded.value) return 100
  if (!progress.value?.totalChapters || progress.value.stage !== 'downloading') return undefined
  return Math.min(100, Math.round((100 * (progress.value.completedChapters ?? 0)) / progress.value.totalChapters))
})
const barStyle = computed(() => ({ width: percentage.value === undefined ? '35%' : `${percentage.value}%` }))
const errorText = computed(() => {
  const key = `fanfiction.errors.${props.job.errorCode}`
  return props.job.errorCode ? t(te(key) ? key : 'fanfiction.errors.runtime_failed') : ''
})
const lastStage = computed(() =>
  failed.value && progress.value ? t('fanfiction.progress.failedDuring', { stage: t(`fanfiction.progress.${progress.value.stage}`) }) : '',
)
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center gap-2 text-sm" role="status" aria-live="polite">
      <LoaderCircle v-if="active" class="text-primary size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
      <CircleCheck v-else-if="succeeded" class="text-primary size-4 shrink-0" aria-hidden="true" />
      <CircleAlert v-else-if="failed" class="text-destructive size-4 shrink-0" aria-hidden="true" />
      <span class="font-medium">{{ status }}</span>
      <span v-if="job.attempts > 1" class="text-muted-foreground ml-auto">{{ t('fanfiction.progress.attempt', { count: job.attempts }) }}</span>
    </div>
    <template v-if="job.kind === 'import' && (active || progress || succeeded)">
      <div
        v-if="active || succeeded"
        role="progressbar"
        :aria-label="status"
        :aria-valuenow="percentage"
        :aria-valuetext="chapterLabel || status"
        :aria-valuemin="0"
        :aria-valuemax="100"
        class="bg-muted h-2 overflow-hidden rounded-full"
      >
        <div
          class="bg-primary h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none"
          :class="{ 'motion-safe:animate-pulse': percentage === undefined && active }"
          :style="barStyle"
        />
      </div>
      <div v-if="chapterLabel && !succeeded" class="text-muted-foreground flex justify-between gap-2 text-xs">
        <span>{{ chapterLabel }}</span
        ><span v-if="percentage !== undefined">{{ percentage }}%</span>
      </div>
    </template>
    <p v-if="lastStage" class="text-muted-foreground text-xs">{{ lastStage }}</p>
    <p v-if="errorText" role="alert" class="text-destructive text-sm">{{ errorText }}</p>
  </div>
</template>

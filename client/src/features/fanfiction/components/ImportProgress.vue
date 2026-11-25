<script setup lang="ts">
import { storyIssueRoute } from '../composables/storyReview'
import { needsImportReview } from '../composables/useImportReview'
import TagReviewNotice from './TagReviewNotice.vue'
import StoryUpdateOutcome from './StoryUpdateOutcome.vue'
import { computed } from 'vue'
import { useDownloadActivity } from '../composables/useDownloadActivity'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { CircleAlert, CircleCheck, Clock, LoaderCircle } from '@lucide/vue'
import type { FanfictionJob, FanfictionDownloadRow } from '@bookorbit/types'

const props = defineProps<{ job: FanfictionJob; lastContactAt?: string | null; waitingFor?: FanfictionDownloadRow['waitingFor']; site?: string }>()
const { t, locale } = useI18n()
const {
  message: activityMessage,
  freshness,
  connected,
  chapter,
} = useDownloadActivity(() => ({
  progress: props.job.result?.progress,
  lastContactAt: props.lastContactAt,
  waitingFor: props.waitingFor,
  nextAttemptAt: props.job.nextAttemptAt,
  site: props.site,
}))
const progress = computed(() => props.job.result?.progress)
const active = computed(() => ['queued', 'running'].includes(props.job.state))
const succeeded = computed(() => ['succeeded', 'no_change'].includes(props.job.state))
const reviewing = computed(() => needsImportReview(props.job) || (props.job.state === 'review_required' && !!props.job.result?.metadataReview))
const failed = computed(() => !reviewing.value && ['failed', 'configuration_blocked', 'review_required'].includes(props.job.state))
const nextAttempt = computed(() =>
  props.job.state === 'queued' && props.job.nextAttemptAt && !props.job.cancellationRequested
    ? new Date(props.job.nextAttemptAt).toLocaleString(locale.value, { dateStyle: 'short', timeStyle: 'short' })
    : null,
)
const status = computed(() => {
  if (props.job.errorCode === 'download_paused') return t('bookMetadataFetch.label.paused')
  if (props.job.cancellationRequested && active.value) return t('fanfiction.progress.cancelling')
  if (props.job.state === 'queued' && !props.waitingFor && props.job.nextAttemptAt && props.job.attempts > 0) return t('fanfiction.progress.retrying')
  if (props.job.state === 'running' && (progress.value || ['import', 'preview'].includes(props.job.kind)))
    return t(`fanfiction.progress.${progress.value?.stage ?? 'metadata'}`)
  return t(`fanfiction.states.${props.job.state}`)
})
const chapterLabel = computed(() =>
  progress.value?.totalChapters
    ? t('fanfiction.progress.ready', {
        completed: progress.value.completedChapters ?? 0,
        total: progress.value.totalChapters,
      })
    : '',
)
const percentage = computed(() => {
  if (succeeded.value) return 100
  if (!progress.value?.totalChapters || progress.value.stage !== 'downloading') return undefined
  return Math.min(100, Math.round((100 * (progress.value.completedChapters ?? 0)) / progress.value.totalChapters))
})
const errorText = computed(() => {
  if (props.job.errorCode === 'download_paused') return ''
  const key = `fanfiction.errors.${props.job.errorCode}`
  return (!active.value || (props.job.state === 'queued' && props.job.attempts > 0)) && !reviewing.value && props.job.errorCode
    ? t(key, t('fanfiction.errors.runtime_failed'))
    : ''
})
const lastStage = computed(() =>
  failed.value && progress.value ? t('fanfiction.progress.failedDuring', { stage: t(`fanfiction.progress.${progress.value.stage}`) }) : '',
)
</script>

<template>
  <div class="space-y-2">
    <RouterLink
      v-if="(job.result?.metadataReview || job.result?.contentReview) && job.result.bookId"
      :to="storyIssueRoute(job.libraryId, job.result.sourceId, job.result.bookId, job.errorCode)"
      class="text-primary block font-medium underline"
      >{{
        t(job.result?.contentReview && !job.result.contentReview.approved ? 'fanfiction.storyUpdates' : 'fanfiction.metadataReview.title')
      }}</RouterLink
    >
    <div class="flex items-center gap-2 text-sm" role="status" aria-live="polite">
      <Clock v-if="nextAttempt" class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
      <LoaderCircle v-else-if="active" class="text-primary size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
      <CircleCheck v-else-if="succeeded" class="text-primary size-4 shrink-0" aria-hidden="true" />
      <CircleAlert v-else-if="failed" class="text-destructive size-4 shrink-0" aria-hidden="true" />
      <span class="font-medium">{{ status }}</span>
      <span v-if="job.attempts > 1" class="text-muted-foreground ml-auto">{{ t('fanfiction.progress.attempt', { count: job.attempts }) }}</span>
    </div>
    <p v-if="active && job.state === 'running' && chapter" class="text-sm font-medium break-words">{{ chapter }}</p>
    <p v-if="active && activityMessage" class="text-sm text-muted-foreground">{{ activityMessage }}</p>
    <p v-if="active && job.state === 'running' && freshness" class="text-xs text-muted-foreground">
      {{ freshness }}<span v-if="connected"> · {{ t('fanfiction.liveActivity.connected') }}</span>
    </p>
    <p v-if="nextAttempt && !waitingFor" class="text-muted-foreground text-sm">
      <time :datetime="job.nextAttemptAt">{{ t('fanfiction.progress.nextAttempt', { time: nextAttempt }) }}</time>
    </p>
    <template v-if="['import', 'update', 'refresh'].includes(job.kind) && (progress || (job.kind === 'import' && (active || succeeded)))">
      <progress
        v-if="active && !nextAttempt"
        role="progressbar"
        :value="percentage"
        max="100"
        :aria-label="status"
        :aria-valuenow="percentage"
        :aria-valuetext="chapterLabel || status"
        :aria-valuemin="0"
        :aria-valuemax="100"
        class="block h-2 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary"
      />
      <div v-if="chapterLabel && !succeeded" class="text-muted-foreground flex justify-between gap-2 text-xs">
        <span>{{ chapterLabel }}</span
        ><span v-if="percentage !== undefined">{{ percentage }}%</span>
      </div>
    </template>
    <p v-if="job.result?.importReview?.approved && (active || failed)" class="flex items-center gap-2 text-sm text-muted-foreground">
      <CircleCheck class="size-4 shrink-0" aria-hidden="true" />{{ t('fanfiction.importInbox.saved') }}
    </p>
    <TagReviewNotice v-else :count="job.result?.preview?.pendingLabelCount ?? job.result?.importReview?.preview?.pendingLabelCount" />
    <StoryUpdateOutcome :job="job" />
    <p v-if="lastStage" class="text-muted-foreground text-xs">{{ lastStage }}</p>
    <p v-if="errorText" role="alert" class="text-destructive text-sm">{{ errorText }}</p>
  </div>
</template>

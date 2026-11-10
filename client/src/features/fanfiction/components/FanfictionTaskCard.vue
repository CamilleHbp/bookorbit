<script setup lang="ts">
import { needsImportReview } from '../composables/useImportReview'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { FanfictionJob } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { relativeTimestamp } from '@/lib/relative-time'
import ImportProgress from './ImportProgress.vue'
import StoryImportReview from './StoryImportReview.vue'

const props = defineProps<{ job: FanfictionJob; busy: boolean; bulkBusy: boolean; canManage: boolean }>()
const emit = defineEmits<{
  cancel: [job: FanfictionJob]
  retry: [job: FanfictionJob]
  review: [job: FanfictionJob]
  fixLogin: [sourceId: string]
  accepted: [job: FanfictionJob]
}>()
const { t } = useI18n()

const loginErrors = ['authentication_required', 'access_denied', 'configuration_blocked']
const retryStates = ['failed', 'cancelled', 'configuration_blocked', 'review_required']

const site = computed(() => {
  try {
    return new URL(props.job.url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
})
const title = computed(() => {
  const result = props.job.result
  if (props.job.kind === 'source_batch') return t('fanfiction.kinds.source_batch')
  return (
    props.job.sourceTitle ??
    result?.importReview?.preview?.title ??
    result?.preview?.title ??
    result?.existingStory?.title ??
    result?.replacement?.title ??
    props.job.url
  )
})
const active = computed(() => ['queued', 'running'].includes(props.job.state))
const needsLogin = computed(() => loginErrors.includes(props.job.errorCode ?? ''))
const loginSourceId = computed(() => (needsLogin.value ? (props.job.result?.sourceId ?? null) : null))
const canRetry = computed(
  () =>
    !active.value &&
    !needsLogin.value &&
    !props.job.result?.contentReview &&
    !props.job.result?.metadataReview &&
    (!props.job.result?.importReview || props.job.result.importReview.approved) &&
    retryStates.includes(props.job.state),
)
const reviewingImport = computed(() => needsImportReview(props.job))
const bookId = computed(() => props.job.result?.bookId)
const updatedAt = computed(() => relativeTimestamp(props.job.updatedAt))
const updatedAtFull = computed(() => new Date(props.job.updatedAt).toLocaleString())

function handleCancel() {
  emit('cancel', props.job)
}
function handleRetry() {
  emit('retry', props.job)
}
function handleReview() {
  emit('review', props.job)
}
function handleFixLogin() {
  if (loginSourceId.value) emit('fixLogin', loginSourceId.value)
}
function handleAccepted(job: FanfictionJob) {
  emit('accepted', job)
}
</script>

<template>
  <article class="border-border bg-card space-y-3 rounded-lg border p-4">
    <header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 class="min-w-0 font-medium break-words">
        <RouterLink
          v-if="bookId"
          :to="{ name: 'book-detail', params: { bookId } }"
          class="underline decoration-border underline-offset-4 hover:decoration-current"
          >{{ title }}</RouterLink
        >
        <template v-else>{{ title }}</template>
      </h3>
      <p class="text-muted-foreground text-sm">
        {{ t(`fanfiction.kinds.${job.kind}`) }}<template v-if="site"> · {{ site }}</template> ·
        <time :datetime="job.updatedAt" :title="updatedAtFull">{{ updatedAt }}</time>
      </p>
    </header>
    <StoryImportReview v-if="reviewingImport" :job="job" :disabled="!canManage" @updated="handleAccepted" />
    <ImportProgress v-else :job="job" />
    <div v-if="active || canRetry || needsLogin || job.kind === 'source_batch'" class="flex flex-wrap gap-2">
      <Button v-if="job.kind === 'source_batch'" variant="outline" :disabled="busy || bulkBusy" @click="handleReview">{{
        t('fanfiction.bulk.review')
      }}</Button>
      <Button v-if="active" variant="outline" :disabled="busy || job.cancellationRequested" @click="handleCancel">{{
        t('fanfiction.cancel')
      }}</Button>
      <template v-else-if="needsLogin">
        <Button v-if="loginSourceId" :disabled="busy" @click="handleFixLogin">{{ t('fanfiction.bulk.fixLogin') }}</Button>
        <Button v-else as-child
          ><RouterLink :to="{ name: 'settings-website-logins' }">{{ t('fanfiction.tasks.websiteLogins') }}</RouterLink></Button
        >
      </template>
      <Button v-if="canRetry" variant="outline" :disabled="busy" @click="handleRetry">{{ t('fanfiction.retry') }}</Button>
    </div>
  </article>
</template>

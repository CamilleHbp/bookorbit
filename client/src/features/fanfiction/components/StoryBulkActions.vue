<script setup lang="ts">
import { computed, type UnwrapNestedRefs } from 'vue'
import { RouterLink } from 'vue-router'
import StorySchedule from './StorySchedule.vue'
import type { FanfictionSourceBatchAction } from '@bookorbit/types'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import type { useFanfictionSourceBatch } from '../composables/useFanfictionSourceBatch'

const props = defineProps<{
  bulk: UnwrapNestedRefs<ReturnType<typeof useFanfictionSourceBatch>>
  loading: boolean
  selecting: boolean
  libraryName: string
  matchingCount?: number
  allowAllMatching?: boolean
}>()
const emit = defineEmits<{ fixLogin: [sourceId: string] }>()
const { t } = useI18n()
function fixLogin(id: string) {
  emit('fixLogin', id)
}
const allMatching = defineModel<boolean>('allMatching', { required: true })
const action = defineModel<FanfictionSourceBatchAction>('action', { required: true })
const interval = defineModel<string>('interval', { required: true })
const heading = computed(() => {
  if (props.bulk.active) return t('fanfiction.bulk.checking')
  if (props.bulk.job?.state === 'cancelled') return t('fanfiction.bulk.stopped')
  if (props.bulk.job?.state === 'failed' || props.bulk.job?.state === 'configuration_blocked') return t('fanfiction.bulk.interrupted')
  return t('fanfiction.bulk.finished')
})
const selectedCount = computed(() => (props.bulk.allMatching ? props.matchingCount : props.bulk.selectedIds.length))
const selectionText = computed(() => t('fanfiction.bulk.selectedCount', { count: selectedCount.value ?? 0 }))
const summary = computed(() => props.bulk.summary)
const skipped = computed(() =>
  summary.value && !bulkSelecting.value ? Math.max(0, (summary.value.total ?? 0) - summary.value.checked - summary.value.running) : 0,
)
const bulkSelecting = computed(() => props.bulk.selecting)
const schedule = computed(() => props.bulk.job?.result?.selection?.action === 'schedule')
const stats = computed(() =>
  summary.value
    ? [
        { label: t('fanfiction.bulk.updated'), count: summary.value.updated },
        { label: t('fanfiction.bulk.unchanged'), count: summary.value.unchanged },
        { label: t('fanfiction.bulk.attention'), count: summary.value.needsAttention },
        { label: t('fanfiction.bulk.running'), count: summary.value.running },
      ]
    : [],
)
const failureGroups = computed(() => {
  const groups = new Map<string, typeof props.bulk.failures>()
  for (const failure of props.bulk.failures) {
    const group = groups.get(failure.errorCode) ?? []
    group.push(failure)
    groups.set(failure.errorCode, group)
  }
  return Array.from(groups, ([code, failures]) => ({ code, failures }))
})
</script>

<template>
  <section class="space-y-3 border-y border-border py-3" :aria-label="t('fanfiction.bulk.title')">
    <template v-if="selecting && !bulk.active">
      <div class="flex flex-wrap items-center gap-2">
        <p role="status" class="me-auto text-sm font-medium tabular-nums">{{ selectionText }}</p>
        <Button variant="ghost" :disabled="loading || bulk.busy || bulk.allMatching" @click="bulk.selectPage">{{
          t('fanfiction.bulk.selectPage')
        }}</Button>
        <Button variant="ghost" :disabled="bulk.busy" @click="bulk.clearSelection">{{ t('fanfiction.bulk.clear') }}</Button>
      </div>
      <div class="flex flex-wrap items-end gap-2">
        <label class="min-w-0 flex-1 space-y-1 text-sm">
          {{ t('fanfiction.bulk.action') }}
          <select
            v-model="action"
            :disabled="bulk.busy"
            class="border-input bg-background block min-h-11 w-full rounded-md border px-3 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <option value="update">{{ t('fanfiction.bulk.update') }}</option>
            <option value="refresh">{{ t('fanfiction.bulk.refresh') }}</option>
            <option value="retry">{{ t('fanfiction.bulk.retry') }}</option>
            <option value="policy">{{ t('fanfiction.bulk.policy') }}</option>
            <option value="schedule">{{ t('fanfiction.bulk.schedule') }}</option>
          </select>
        </label>
        <StorySchedule v-if="bulk.action === 'schedule'" v-model="interval" :disabled="bulk.busy" />
        <Button class="min-h-11" :disabled="loading || !bulk.canStart" @click="bulk.start">{{ t(`fanfiction.bulk.${action}`) }}</Button>
      </div>
      <label
        v-if="allowAllMatching !== false && matchingCount !== undefined"
        class="flex min-h-11 cursor-pointer items-center gap-3 rounded-md text-sm has-focus-visible:ring-2 has-focus-visible:ring-ring"
      >
        <input v-model="allMatching" type="checkbox" class="size-4 accent-primary" :disabled="loading || bulk.busy" />
        {{ t('fanfiction.bulk.allMatchingCount', { count: matchingCount }) }}
      </label>
      <p v-if="bulk.action === 'policy'" class="text-sm text-muted-foreground">{{ t('fanfiction.maintenance.safeHelp') }}</p>
      <p v-if="bulk.action === 'refresh'" class="text-sm text-muted-foreground">{{ t('fanfiction.bulk.refreshHelp') }}</p>
      <p v-if="bulk.action === 'schedule'" class="text-sm text-muted-foreground">{{ t('fanfiction.bulk.scheduleHelp') }}</p>
    </template>
    <p v-if="bulk.error" role="alert" class="text-sm text-destructive">{{ bulk.error }}</p>
    <div v-if="bulk.job" class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-sm font-semibold">{{ schedule ? t('fanfiction.bulk.schedule') : heading }} · {{ libraryName }}</h2>
        <div class="flex flex-wrap gap-2">
          <Button variant="ghost" :disabled="bulk.busy" @click="bulk.refresh">{{ t('fanfiction.bulk.reload') }}</Button>
          <Button v-if="bulk.selecting" variant="outline" :disabled="bulk.busy || bulk.job.cancellationRequested" @click="bulk.cancel">{{
            t('fanfiction.bulk.stop')
          }}</Button>
          <Button v-if="bulk.canRetry" variant="outline" :disabled="bulk.busy" @click="bulk.retry">{{ t('fanfiction.bulk.retryFailed') }}</Button>
        </div>
      </div>
      <div v-if="summary?.trackingAvailable" role="status" class="space-y-2 text-sm tabular-nums">
        <p>{{ t('fanfiction.bulk.checked', { count: summary.checked, total: summary.total ?? summary.checked }) }}</p>
        <progress
          v-if="summary.total"
          class="block h-1.5 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary"
          :value="summary.checked"
          :max="summary.total"
          :aria-label="t('fanfiction.bulk.libraryProgress')"
        />
        <ul v-if="!schedule" class="flex flex-wrap gap-x-5 gap-y-1">
          <li v-for="stat in stats" :key="stat.label">
            <span class="font-medium">{{ stat.count }}</span> <span class="text-muted-foreground">{{ stat.label }}</span>
          </li>
          <li v-if="skipped">
            <span class="font-medium">{{ skipped }}</span> <span class="text-muted-foreground">{{ t('fanfiction.bulk.skipped') }}</span>
          </li>
          <li v-if="summary.waiting">
            <span class="font-medium">{{ summary.waiting }}</span> <span class="text-muted-foreground">{{ t('fanfiction.bulk.waiting') }}</span>
          </li>
        </ul>
      </div>
      <p v-else class="text-sm text-muted-foreground">{{ t(bulk.job.result?.selection?.tracked ? 'common.loading' : 'fanfiction.bulk.legacy') }}</p>
      <p v-if="bulk.job.errorCode" class="text-sm text-destructive">{{ t(`fanfiction.errors.${bulk.job.errorCode}`) }}</p>
      <p v-if="bulk.job.cancellationRequested && bulk.active" class="text-sm text-muted-foreground">{{ t('fanfiction.bulk.cancelHelp') }}</p>
      <details v-if="bulk.failures.length" class="border-t border-border pt-2">
        <summary class="min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
          {{ t('fanfiction.bulk.failures') }}
        </summary>
        <div v-for="group in failureGroups" :key="group.code" class="space-y-2 pb-3">
          <p class="text-sm text-muted-foreground">{{ t(`fanfiction.errors.${group.code}`) }}</p>
          <ul class="space-y-1 text-sm">
            <li v-for="failure in group.failures" :key="failure.sourceId" class="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <span class="min-w-0 flex-1 break-words font-medium">{{ failure.title }}</span>
              <Button
                v-if="failure.jobId && !failure.errorCode.includes('review')"
                variant="outline"
                :disabled="bulk.busy || bulk.active"
                @click="bulk.retryStory(failure.jobId)"
                >{{ t('fanfiction.retry') }}</Button
              >
              <Button
                v-if="failure.errorCode === 'authentication_required'"
                variant="outline"
                :disabled="loading || bulk.busy || bulk.active"
                @click="fixLogin(failure.sourceId)"
                >{{ t('fanfiction.bulk.fixLogin') }}</Button
              >
              <Button v-else variant="ghost" as-child>
                <RouterLink
                  :to="
                    failure.bookId
                      ? { name: 'book-detail', params: { bookId: failure.bookId }, query: { tab: 'story-updates' } }
                      : { name: 'fanfiction', query: { libraryId: bulk.job.libraryId, sourceId: failure.sourceId, tab: 'activity' } }
                  "
                  >{{
                    t(failure.errorCode === 'metadata_review_required' ? 'fanfiction.metadataReview.title' : 'fanfiction.reviewStory')
                  }}</RouterLink
                >
              </Button>
            </li>
          </ul>
        </div>
        <Button v-if="bulk.failureCursor" variant="outline" :disabled="bulk.busy" @click="bulk.moreFailures">{{ t('fanfiction.nextPage') }}</Button>
      </details>
    </div>
  </section>
</template>

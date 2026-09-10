<script setup lang="ts">
import StorySchedule from './StorySchedule.vue'
import type { FanfictionSourceBatchAction } from '@bookorbit/types'
import type { UnwrapNestedRefs } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import type { useFanfictionSourceBatch } from '../composables/useFanfictionSourceBatch'

defineProps<{ bulk: UnwrapNestedRefs<ReturnType<typeof useFanfictionSourceBatch>>; loading: boolean; allowAllMatching?: boolean }>()
const { t } = useI18n()
const allMatching = defineModel<boolean>('allMatching', { required: true })
const action = defineModel<FanfictionSourceBatchAction>('action', { required: true })
const interval = defineModel<string>('interval', { required: true })
</script>

<template>
  <section class="border-border bg-card space-y-3 rounded-lg border p-4" :aria-label="t('fanfiction.bulk.title')">
    <h2 class="font-medium">{{ t('fanfiction.bulk.title') }}</h2>
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="outline" :disabled="loading || bulk.busy || bulk.active || bulk.allMatching" @click="bulk.selectPage">{{
        t('fanfiction.bulk.selectPage')
      }}</Button>
      <Button variant="outline" :disabled="bulk.busy || bulk.active" @click="bulk.clearSelection">{{ t('fanfiction.bulk.clear') }}</Button>
      <span v-if="!bulk.allMatching" class="text-muted-foreground text-sm">{{
        t('fanfiction.bulk.selected', { count: bulk.selectedIds.length })
      }}</span>
    </div>
    <label v-if="allowAllMatching !== false" class="flex items-center gap-2 text-sm">
      <input v-model="allMatching" type="checkbox" :disabled="loading || bulk.busy || bulk.active" />
      {{ t('fanfiction.bulk.allMatching') }}
    </label>
    <p v-if="bulk.allMatching" class="text-muted-foreground text-xs">{{ t('fanfiction.bulk.cutoffHelp') }}</p>
    <div class="flex flex-wrap items-end gap-3">
      <label class="space-y-1 text-sm"
        >{{ t('fanfiction.bulk.action') }}
        <select v-model="action" :disabled="bulk.busy || bulk.active" class="border-input bg-background block rounded-md border p-2">
          <option value="update">{{ t('fanfiction.bulk.update') }}</option>
          <option value="refresh">{{ t('fanfiction.bulk.refresh') }}</option>
          <option value="retry">{{ t('fanfiction.bulk.retry') }}</option>
          <option value="schedule">{{ t('fanfiction.bulk.schedule') }}</option>
        </select>
      </label>
      <StorySchedule v-if="bulk.action === 'schedule'" v-model="interval" :disabled="bulk.busy || bulk.active" />
      <Button :disabled="loading || !bulk.canStart" @click="bulk.start">{{ t('fanfiction.bulk.start') }}</Button>
    </div>
    <p v-if="bulk.action === 'refresh'" class="text-muted-foreground text-sm">{{ t('fanfiction.bulk.refreshHelp') }}</p>
    <p v-if="bulk.action === 'schedule'" class="text-muted-foreground text-sm">{{ t('fanfiction.bulk.scheduleHelp') }}</p>
    <p v-if="bulk.error" role="alert" class="text-destructive text-sm">{{ bulk.error }}</p>
    <div v-if="bulk.job" class="space-y-2 text-sm" aria-live="polite">
      <p>{{ t(`fanfiction.bulk.${bulk.job.result?.selection?.action || 'update'}`) }} · {{ t(`fanfiction.states.${bulk.job.state}`) }}</p>
      <p v-if="bulk.job.result?.selection">{{ t('fanfiction.bulk.progress', bulk.job.result.selection) }}</p>
      <p v-if="bulk.job.errorCode" class="text-destructive">{{ t(`fanfiction.errors.${bulk.job.errorCode}`) }}</p>
      <p class="text-muted-foreground">{{ t('fanfiction.bulk.queuedHelp') }}</p>
      <p v-if="bulk.active" class="text-muted-foreground">{{ t('fanfiction.bulk.cancelHelp') }}</p>
    </div>
    <div class="flex flex-wrap gap-2">
      <Button v-if="bulk.job || bulk.error" variant="outline" :disabled="bulk.busy" @click="bulk.refresh">{{ t('fanfiction.refresh') }}</Button>
      <Button v-if="bulk.active" variant="outline" :disabled="bulk.busy || bulk.job?.cancellationRequested" @click="bulk.cancel">{{
        t('fanfiction.cancel')
      }}</Button>
      <Button v-if="bulk.canRetry" variant="outline" :disabled="bulk.busy" @click="bulk.retry">{{
        bulk.job?.state === 'review_required' ? t('fanfiction.bulk.retryFailed') : t('fanfiction.retry')
      }}</Button>
    </div>
    <div v-if="bulk.failures.length" class="space-y-2">
      <h3 class="text-sm font-medium">{{ t('fanfiction.bulk.failures') }}</h3>
      <ul class="space-y-2 text-sm">
        <li v-for="failure in bulk.failures" :key="failure.sourceId" class="border-border rounded-md border p-2">
          <p class="font-medium">{{ failure.title }}</p>
          <p class="text-muted-foreground">{{ t(`fanfiction.errors.${failure.errorCode}`) }}</p>
        </li>
      </ul>
      <Button v-if="bulk.failureCursor" variant="outline" :disabled="bulk.busy" @click="bulk.moreFailures">{{ t('fanfiction.nextPage') }}</Button>
    </div>
  </section>
</template>

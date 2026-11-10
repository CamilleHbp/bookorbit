<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from '@lucide/vue'
import type { FanfictionJob } from '@bookorbit/types'
import FanfictionTaskCard from './FanfictionTaskCard.vue'
import FanfictionPagination from './FanfictionPagination.vue'

const cards = ref<InstanceType<typeof FanfictionTaskCard>[]>([])
defineExpose({ canLeave: () => cards.value.every((card) => card.canLeave()) })
const props = defineProps<{
  jobs: FanfictionJob[]
  page: number
  previous: boolean
  next: boolean
  busy: boolean
  bulkBusy: boolean
  canManage: boolean
  scoped: boolean
}>()
const emit = defineEmits<{
  cancel: [job: FanfictionJob]
  retry: [job: FanfictionJob]
  review: [job: FanfictionJob]
  fixLogin: [sourceId: string]
  accepted: [job: FanfictionJob]
  previous: []
  next: []
}>()
const { t } = useI18n()

const pending = computed(() => props.jobs.filter((job) => !['succeeded', 'no_change', 'cancelled'].includes(job.state)))
const finished = computed(() => props.jobs.filter((job) => ['succeeded', 'no_change', 'cancelled'].includes(job.state)))

function handleCancel(job: FanfictionJob) {
  emit('cancel', job)
}
function handleRetry(job: FanfictionJob) {
  emit('retry', job)
}
function handleReview(job: FanfictionJob) {
  emit('review', job)
}
function handleFixLogin(sourceId: string) {
  emit('fixLogin', sourceId)
}
function handleAccepted(job: FanfictionJob) {
  emit('accepted', job)
}
function handlePrevious() {
  emit('previous')
}
function handleNext() {
  emit('next')
}
</script>

<template>
  <section class="space-y-3" aria-labelledby="fanfiction-tasks-heading">
    <header class="flex flex-wrap items-baseline justify-between gap-3">
      <h2 id="fanfiction-tasks-heading" class="text-lg font-semibold">{{ t('fanfiction.tasks.title') }}</h2>
      <RouterLink v-if="scoped" :to="{ name: 'fanfiction', query: { tab: 'activity' } }" class="text-primary text-sm underline underline-offset-4">{{
        t('fanfiction.metadataReview.allActivity')
      }}</RouterLink>
    </header>
    <p v-if="!jobs.length" class="text-muted-foreground text-sm">{{ t('fanfiction.tasks.empty') }}</p>
    <ul v-if="pending.length" class="space-y-3">
      <li v-for="job in pending" :key="job.id">
        <FanfictionTaskCard
          ref="cards"
          :job="job"
          :busy="busy"
          :bulk-busy="bulkBusy"
          :can-manage="canManage"
          @cancel="handleCancel"
          @retry="handleRetry"
          @review="handleReview"
          @fix-login="handleFixLogin"
          @accepted="handleAccepted"
        />
      </li>
    </ul>
    <details v-if="finished.length" class="group" :open="!pending.length">
      <summary class="text-muted-foreground hover:text-foreground flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium">
        <ChevronRight class="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />{{
          t('fanfiction.tasks.completed', { count: finished.length })
        }}
      </summary>
      <ul class="space-y-3 pt-1">
        <li v-for="job in finished" :key="job.id">
          <FanfictionTaskCard
            ref="cards"
            :job="job"
            :busy="busy"
            :bulk-busy="bulkBusy"
            :can-manage="canManage"
            @cancel="handleCancel"
            @retry="handleRetry"
            @review="handleReview"
            @fix-login="handleFixLogin"
            @accepted="handleAccepted"
          />
        </li>
      </ul>
    </details>
    <FanfictionPagination
      :page="page"
      :previous="previous"
      :next="next"
      :busy="busy"
      :label="t('fanfiction.tasks.title')"
      :previous-label="t('fanfiction.changeLog.newer')"
      :next-label="t('fanfiction.changeLog.older')"
      @previous="handlePrevious"
      @next="handleNext"
    />
  </section>
</template>

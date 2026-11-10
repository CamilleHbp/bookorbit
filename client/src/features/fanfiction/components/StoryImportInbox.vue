<script setup lang="ts">
import { needsImportReview } from '../composables/useImportReview'
import { computed, nextTick, ref, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { ArrowLeft, RefreshCw } from '@lucide/vue'
import type { FanfictionJob } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { useImportInbox } from '../composables/useImportInbox'
import StoryImportReview from './StoryImportReview.vue'
import ImportProgress from './ImportProgress.vue'
import FanfictionPagination from './FanfictionPagination.vue'

const props = defineProps<{ libraryId: number; disabled?: boolean }>()
const { t } = useI18n()
const inbox = useImportInbox(toRef(props, 'libraryId'))
const { jobs, recentDownloads, busy, error, actionId, nextCursor, page, reload, next, previous, retry, cancel } = inbox
const selectedId = ref<string | null>(null)
const selected = computed(() => jobs.value.find((job) => job.id === selectedId.value))
const editor = ref<InstanceType<typeof StoryImportReview>>()
const listHeading = ref<HTMLElement>()
const reviewHeading = ref<HTMLElement>()
function title(job: FanfictionJob) {
  return job.result?.importReview?.values.title || job.sourceTitle || job.result?.preview?.title || job.url
}
function site(job: FanfictionJob) {
  try {
    return new URL(job.url).hostname.replace(/^www\./, '')
  } catch {
    return job.url
  }
}
function canRetry(job: FanfictionJob) {
  return (
    !(job.result?.contentReview && !job.result.contentReview.approved) &&
    !(job.result?.metadataReview?.beforeUpdate && !job.result.preparedUpdate?.approved) &&
    ['failed', 'cancelled', 'configuration_blocked', 'review_required'].includes(job.state) &&
    (!job.result?.importReview || job.result.importReview.approved)
  )
}
async function open(job: FanfictionJob) {
  selectedId.value = job.id
  await nextTick()
  reviewHeading.value?.focus()
}
function canLeave() {
  return editor.value?.canLeave() ?? true
}
async function back() {
  if (!canLeave()) return
  selectedId.value = null
  await nextTick()
  listHeading.value?.focus()
}
async function updated(job: FanfictionJob) {
  inbox.updated(job)
  selectedId.value = null
  await nextTick()
  listHeading.value?.focus()
}
function canRestart(job: FanfictionJob) {
  return (
    ['failed', 'cancelled'].includes(job.state) &&
    job.result?.importReview?.approved &&
    ['metadata', 'downloading', 'packaging', 'validating'].includes(job.result.progress?.stage ?? 'metadata')
  )
}
function restartDownload(job: FanfictionJob) {
  if (window.confirm(t('fanfiction.importInbox.confirmRestart', { title: title(job) }))) void inbox.restart(job)
}
defineExpose({ canLeave, reload })
</script>
<template>
  <section class="space-y-6" :aria-label="t('fanfiction.importInbox.title')" :aria-busy="busy">
    <header v-if="!selected || !needsImportReview(selected)" class="flex items-start justify-between gap-4">
      <div class="space-y-1">
        <h2 ref="listHeading" tabindex="-1" class="text-xl font-semibold">{{ t('fanfiction.importInbox.title') }}</h2>
        <p class="max-w-prose text-sm text-muted-foreground">{{ t('fanfiction.importInbox.description') }}</p>
      </div>
      <Button variant="ghost" class="size-11 shrink-0" :disabled="busy || !!actionId" :aria-label="t('fanfiction.refresh')" @click="reload">
        <RefreshCw class="size-4" :class="{ 'motion-safe:animate-spin': busy }" aria-hidden="true" />
      </Button>
    </header>
    <div v-if="error" role="alert" class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive p-3">
      <p class="text-sm text-destructive">{{ t('fanfiction.importInbox.loadFailed') }}</p>
      <Button variant="outline" :disabled="busy" @click="reload">{{ t('fanfiction.refresh') }}</Button>
    </div>
    <template v-if="selected && needsImportReview(selected)">
      <Button variant="ghost" :disabled="!!actionId" @click="back"
        ><ArrowLeft class="size-4" aria-hidden="true" />{{ t('fanfiction.importInbox.back') }}</Button
      >
      <div class="space-y-1">
        <h2 ref="reviewHeading" tabindex="-1" class="break-words text-xl font-semibold">{{ title(selected) }}</h2>
        <p v-if="selected.result?.importReview?.preview.chapterCount" class="text-sm text-muted-foreground">
          {{ t('fanfiction.chapterCount', { count: selected.result.importReview.preview.chapterCount }) }}
        </p>
        <a :href="selected.url" target="_blank" rel="noopener noreferrer" class="text-sm text-primary underline underline-offset-4">{{
          site(selected)
        }}</a>
      </div>
      <StoryImportReview ref="editor" :key="selected.id" :job="selected" :disabled="disabled" @updated="updated" />
    </template>
    <template v-else>
      <div v-if="busy && !jobs.length" class="space-y-3" role="status">
        <p class="text-sm text-muted-foreground">{{ t('common.loading') }}</p>
        <div v-for="row in 3" :key="row" class="h-20 rounded-md bg-muted motion-safe:animate-pulse" aria-hidden="true" />
      </div>
      <div v-else-if="!jobs.length && !error" class="space-y-2 py-8">
        <h3 class="font-medium">{{ t('fanfiction.importInbox.empty') }}</h3>
        <p class="text-sm text-muted-foreground">{{ t('fanfiction.importInbox.emptyHint') }}</p>
      </div>
      <ul v-else class="divide-y divide-border border-y border-border">
        <li v-for="job in jobs" :key="job.id" class="space-y-3 py-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1 basis-48 space-y-1">
              <h3 class="break-words font-semibold">{{ title(job) }}</h3>
              <span v-if="job.kind !== 'import'" class="me-2 text-sm text-muted-foreground">{{ t(`fanfiction.kinds.${job.kind}`) }}</span>
              <a
                :href="job.url"
                target="_blank"
                rel="noopener noreferrer"
                class="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >{{ site(job) }}</a
              >
            </div>
            <Button v-if="needsImportReview(job)" :disabled="disabled || !!actionId" @click="open(job)">{{ t('fanfiction.previewStory') }}</Button>
            <Button v-else-if="canRetry(job)" :disabled="disabled || !!actionId" @click="retry(job)">{{ t('fanfiction.importInbox.retry') }}</Button>
            <Button
              v-else-if="['queued', 'running'].includes(job.state)"
              variant="outline"
              :disabled="disabled || !!actionId || job.cancellationRequested"
              @click="cancel(job)"
              >{{ t('fanfiction.cancel') }}</Button
            >
          </div>
          <p v-if="needsImportReview(job)" class="text-sm text-muted-foreground">{{ t('fanfiction.importInbox.ready') }}</p>
          <ImportProgress v-else :job="job" />
          <button
            v-if="canRestart(job)"
            type="button"
            class="min-h-11 text-sm text-muted-foreground underline underline-offset-4"
            :disabled="disabled || !!actionId"
            @click="restartDownload(job)"
          >
            {{ t('fanfiction.importInbox.restart') }}
          </button>
          <Button v-if="job.state === 'configuration_blocked'" variant="outline" as-child>
            <RouterLink to="/settings/website-logins">{{ t('fanfiction.configureSource') }}</RouterLink>
          </Button>
        </li>
      </ul>
      <section v-if="recentDownloads.length" class="space-y-2">
        <h3 class="font-semibold">{{ t('fanfiction.importInbox.recent') }}</h3>
        <ul class="divide-y divide-border">
          <li v-for="book in recentDownloads" :key="book.id">
            <RouterLink
              :to="{ name: 'book-detail', params: { bookId: book.bookId } }"
              class="flex min-h-11 items-center justify-between gap-3 py-2 text-sm"
            >
              <span class="min-w-0 break-words">{{ book.title }}</span
              ><span class="shrink-0 text-primary underline underline-offset-4">{{ t('fanfiction.openBook') }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>
      <FanfictionPagination
        :page="page"
        :previous="page > 1"
        :next="!!nextCursor"
        :busy="busy || !!actionId"
        :label="t('fanfiction.importInbox.title')"
        @previous="previous"
        @next="next"
      />
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { canReviewDownload, storyIssueRoute } from '../composables/storyReview'
import { RouterLink, useRouter } from 'vue-router'
import { ArrowUpRight, CircleCheck, CloudDownload, Plus } from '@lucide/vue'
import type { FanfictionDownloadRow, FanfictionJob, FanfictionSourceBatchStatus } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { sections, useDownloadQueue } from '../composables/useDownloadQueue'
import DownloadActivity from './DownloadActivity.vue'
import DownloadSection from './DownloadSection.vue'
import FanfictionLibraryStatus from './FanfictionLibraryStatus.vue'
import DownloadRow from './DownloadRow.vue'
import DownloadJobDetail from './DownloadJobDetail.vue'
import FanfictionPagination from './FanfictionPagination.vue'
const props = defineProps<{
  jobId?: string
  libraryId: number
  checkJob?: FanfictionJob | null
  checkSummary?: FanfictionSourceBatchStatus | null
  checking?: boolean
  checkError?: boolean
}>()
const { t, locale } = useI18n()
const router = useRouter()
const { snapshot, busy, error, lastSeen, refresh, reload, offsets } = useDownloadQueue(props.libraryId)
const visible = computed(() => sections.filter((key) => snapshot.value?.totals[key]))
const inspected = ref<FanfictionDownloadRow>()
const selected = computed(
  () =>
    snapshot.value?.items.find((row) => row.jobId === props.jobId && !row.groupKey) ??
    (inspected.value?.jobId === props.jobId ? inspected.value : undefined),
)
const detail = ref<InstanceType<typeof DownloadJobDetail>>()
const groups = ref<InstanceType<typeof DownloadSection>[]>([])
const finished = ref<InstanceType<typeof DownloadSection>>()
const list = ref<HTMLElement>()
let opener: HTMLElement | null = null
function jump(section: string) {
  const target = section === 'finished' ? finished.value : groups.value.find((group) => group.section === section)
  target?.reveal()
}
function inspect(row: FanfictionDownloadRow) {
  if (canReviewDownload(row)) {
    void router.push(storyIssueRoute(props.libraryId, row.sourceId, row.bookId, row.code))
    return
  }
  if (!row.jobId) return
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  inspected.value = row
  void router.push({ query: { ...router.currentRoute.value.query, libraryId: props.libraryId, jobId: row.jobId }, state: { fanfictionQueue: true } })
}
function close() {
  if (window.history.state?.fanfictionQueue) router.back()
  else void router.replace({ query: { ...router.currentRoute.value.query, jobId: undefined } })
}
watch(
  () => props.jobId,
  async (id, previous) => {
    if (id || !previous) return
    await nextTick()
    ;(opener?.isConnected ? opener : list.value)?.focus()
    refresh()
  },
)
defineExpose({ reload: refresh, canLeave: () => detail.value?.canLeave() ?? true })
</script>
<template>
  <DownloadJobDetail
    ref="detail"
    v-if="jobId"
    :key="jobId"
    :job-id="jobId"
    :row="selected"
    :checked-at="lastSeen"
    :library-id="libraryId"
    @close="close"
  />
  <div v-show="!jobId" ref="list" tabindex="-1" class="flex flex-col gap-4 focus:outline-none">
    <div v-if="error" role="alert" class="rounded-lg border border-warning p-3 text-sm">
      <p>
        {{ t('fanfiction.downloads.loadError') }}
        <span v-if="lastSeen">{{ t('fanfiction.downloads.asOf', { time: lastSeen.toLocaleTimeString(locale) }) }}</span>
        <button
          type="button"
          class="ms-2 inline-flex min-h-11 items-center font-medium text-foreground underline underline-offset-4"
          :disabled="busy"
          @click="refresh"
        >
          {{ t('fanfiction.refresh') }}
        </button>
      </p>
    </div>
    <div v-if="!snapshot && !error" role="status" aria-busy="true" class="space-y-4 rounded-xl border border-border p-5">
      <span class="sr-only">{{ t('common.loading') }}</span>
      <div class="h-5 w-36 rounded bg-muted motion-safe:animate-pulse" />
      <div class="h-4 w-64 max-w-full rounded bg-muted motion-safe:animate-pulse" />
    </div>
    <DownloadActivity v-if="snapshot" :snapshot="snapshot" :checked-at="lastSeen" :error="error" :busy="busy" @refresh="refresh" @jump="jump" />
    <template v-if="snapshot">
      <div v-if="!visible.length" class="flex flex-wrap items-center gap-3 rounded-lg bg-muted/50 px-4 py-3">
        <CloudDownload class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p class="me-auto font-medium">{{ t('fanfiction.importInbox.empty') }}</p>
        <Button variant="outline" as-child class="min-h-11"
          ><RouterLink :to="{ name: 'fanfiction', query: { tab: 'add', libraryId } }"
            ><Plus aria-hidden="true" />{{ t('fanfiction.addStories') }}</RouterLink
          ></Button
        >
      </div>
      <DownloadSection
        ref="groups"
        v-for="key in visible"
        :key="key"
        :library-id="libraryId"
        :section="key"
        :title="t(`fanfiction.downloads.${key}`)"
        :count="snapshot.storyCounts?.[key] ?? snapshot.totals[key]"
      >
        <RouterLink
          v-if="key === 'attention'"
          class="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4"
          :to="{ name: 'fanfiction', query: { tab: 'review', review: 'attention', libraryId } }"
          >{{ t('fanfiction.attentionReview.start') }}</RouterLink
        >
        <DownloadRow
          v-for="row in snapshot.items.filter((item) => item.section === key)"
          :key="row.id"
          :library-id="libraryId"
          :row="row"
          @retried="refresh"
          @inspect="inspect"
        />
        <FanfictionPagination
          :label="t(`fanfiction.downloads.${key}`)"
          :busy="busy"
          :page="offsets[key] / 20 + 1"
          :previous="offsets[key] > 0"
          :next="offsets[key] + 20 < snapshot.totals[key]"
          @next="reload(key, 20)"
          @previous="reload(key, -20)"
        />
      </DownloadSection>
      <DownloadSection
        ref="finished"
        v-if="snapshot.recent.length"
        :library-id="libraryId"
        section="finished"
        :title="t('fanfiction.downloads.finished')"
        :count="snapshot.recent.length"
      >
        <RouterLink
          v-for="book in snapshot.recent"
          :key="book.id"
          :to="{ name: 'book-detail', params: { bookId: book.bookId } }"
          class="flex min-h-14 items-center gap-3 border-b border-border/70 py-2 hover:text-primary"
          ><CircleCheck class="size-4 shrink-0 text-primary" aria-hidden="true" /><span class="flex-1 font-medium break-words">{{ book.title }}</span
          ><span class="text-sm">{{ t('fanfiction.openBook') }}</span
          ><ArrowUpRight class="size-4" aria-hidden="true"
        /></RouterLink>
      </DownloadSection>
    </template>
    <details
      v-if="snapshot || checking || checkError"
      :class="{ 'order-first': checking || checkError }"
      :open="checking || checkError"
      class="border-b border-border pb-3"
    >
      <summary
        class="min-h-11 cursor-pointer py-3 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        {{ t('fanfiction.liveActivity.lastCheck') }}
      </summary>
      <FanfictionLibraryStatus :library-id="libraryId" :job="checkJob" :summary="checkSummary" :checking="checking" :show-actions="checkError"
        ><slot name="check-details"
      /></FanfictionLibraryStatus>
    </details>
  </div>
</template>

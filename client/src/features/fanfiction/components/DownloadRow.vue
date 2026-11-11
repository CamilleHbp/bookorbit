<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, ArrowUpRight, Download } from '@lucide/vue'
import type { FanfictionDownloadRow } from '@bookorbit/types'
import { chapterDecision, issueStyle } from '../composables/downloadIssue'
import DownloadGroupMembers from './DownloadGroupMembers.vue'
const props = defineProps<{ row: FanfictionDownloadRow; libraryId: number }>()
const emit = defineEmits<{ inspect: [row: FanfictionDownloadRow] }>()
const { t, te, locale } = useI18n()
const open = ref(false)
const id = useId()
const decision = computed(() => chapterDecision(props.row))
const reason = computed(() => {
  const row = props.row
  if (row.code === 'source_chapter_reduction' && !row.removed) return t('fanfiction.downloads.fewer')
  if (row.section === 'retrying' && row.issue === 'website')
    return t(row.code === 'source_rate_limited' ? 'fanfiction.downloads.throttled' : 'fanfiction.downloads.tryLater')
  if (row.issue === 'chapter') return t(`fanfiction.downloads.${decision.value.key}`, { count: decision.value.count })
  if (row.code === 'source_failed') return t('fanfiction.downloads.checkFailed')
  if (row.code && te(`fanfiction.errors.${row.code}`)) return t(`fanfiction.errors.${row.code}`)
  return row.issue ? t(`fanfiction.downloads.issue.${row.issue}`) : ''
})
const progress = computed(() => props.row.progress)
const percent = computed(() =>
  progress.value?.stage === 'downloading' && progress.value.totalChapters
    ? Math.min(100, Math.round((100 * (progress.value.completedChapters ?? 0)) / progress.value.totalChapters))
    : null,
)
const time = computed(() =>
  props.row.nextAttemptAt ? new Date(props.row.nextAttemptAt).toLocaleString(locale.value, { dateStyle: 'short', timeStyle: 'short' }) : '',
)
function toggle() {
  open.value = !open.value
}
function inspect() {
  emit('inspect', props.row)
}
function inspectMember(row: FanfictionDownloadRow) {
  emit('inspect', row)
}
</script>
<template>
  <article v-if="row.section === 'running'" class="my-3 space-y-4 rounded-xl bg-primary px-5 py-5 text-primary-foreground sm:px-7">
    <div class="flex items-center gap-2 text-sm">
      <Download class="size-4" aria-hidden="true" />{{ t(row.progress ? 'fanfiction.progress.' + row.progress.stage : 'fanfiction.states.running')
      }}<span class="ms-auto">{{ row.site }}</span>
    </div>
    <div class="flex items-baseline justify-between gap-3">
      <h3 class="min-w-0 font-serif text-2xl leading-tight break-words sm:text-3xl">{{ row.title }}</h3>
      <strong v-if="percent !== null" class="shrink-0 text-2xl tabular-nums">{{ percent }}%</strong>
    </div>
    <progress
      v-if="percent !== null"
      class="block h-2 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-primary-foreground/25 [&::-webkit-progress-value]:bg-primary-foreground [&::-moz-progress-bar]:bg-primary-foreground"
      :value="percent"
      max="100"
      :aria-label="row.title"
    />
    <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span v-if="progress?.totalChapters">{{
        t('fanfiction.progress.ready', {
          completed: progress.completedChapters ?? 0,
          total: progress.totalChapters,
        })
      }}</span
      ><button v-if="row.jobId" class="min-h-9 underline underline-offset-4" @click="inspect">{{ t('fanfiction.downloads.details') }}</button>
    </div>
  </article>
  <article v-else class="border-b border-border/70">
    <div class="flex items-start gap-3 py-3">
      <span v-if="row.issue" class="mt-1 inline-flex size-9 shrink-0 items-center justify-center rounded-lg" :class="issueStyle[row.issue].color"
        ><component :is="issueStyle[row.issue].icon" class="size-4" aria-hidden="true"
      /></span>
      <div class="min-w-0 flex-1">
        <button
          v-if="row.groupKey"
          type="button"
          :aria-expanded="open"
          :aria-controls="id"
          class="flex w-full min-h-11 items-center gap-3 text-start hover:text-primary"
          @click="toggle"
        >
          <span class="min-w-0 flex-1 break-words"
            ><span class="block text-xs font-semibold text-muted-foreground">{{ t('fanfiction.downloads.issue.' + row.issue) }}</span
            ><span class="font-semibold">{{ row.site }}</span></span
          ><span class="shrink-0 text-sm tabular-nums">{{ t('fanfiction.downloads.stories', { count: row.count }) }}</span
          ><ChevronRight class="size-4 shrink-0" :class="{ 'rotate-90': open }" aria-hidden="true" />
        </button>
        <template v-else
          ><p class="text-xs font-semibold text-muted-foreground">
            {{ row.issue ? t('fanfiction.downloads.issue.' + row.issue) + ' · ' : '' }}{{ row.site }}
          </p>
          <button
            v-if="row.jobId"
            class="min-h-8 text-start font-medium break-words underline decoration-border underline-offset-4 hover:decoration-current"
            @click="inspect"
          >
            {{ row.title }}
          </button>
          <RouterLink
            v-else-if="row.bookId"
            :to="{ name: 'book-detail', params: { bookId: row.bookId }, query: { tab: 'story-updates' } }"
            class="inline-flex min-h-9 items-center gap-1 font-medium underline decoration-border underline-offset-4"
            >{{ row.title }}<ArrowUpRight class="size-3" aria-hidden="true"
          /></RouterLink>
          <p v-else class="font-medium break-words">{{ row.title }}</p></template
        >
        <p v-if="reason" class="max-w-prose text-sm text-muted-foreground">{{ reason }}</p>
        <time v-if="row.nextAttemptAt" :datetime="row.nextAttemptAt" class="text-sm tabular-nums">{{
          t('fanfiction.progress.nextAttempt', { time })
        }}</time>
        <p v-else-if="row.issue === 'website' && row.section === 'attention'" class="text-xs text-muted-foreground">
          {{ t('fanfiction.downloads.noRetry') }}
        </p>
      </div>
    </div>
    <div v-if="row.groupKey && open" :id="id" class="ms-4 border-s-2 border-border ps-4 pb-4 sm:ms-7">
      <RouterLink
        v-if="row.issue === 'login'"
        :to="{ name: 'settings-website-logins' }"
        class="inline-block py-2 text-sm font-medium text-primary underline"
        >{{ t('fanfiction.tasks.websiteLogins') }}</RouterLink
      >
      <DownloadGroupMembers :library-id="libraryId" :section="row.section" :group-key="row.groupKey" @inspect="inspectMember" />
    </div>
  </article>
</template>

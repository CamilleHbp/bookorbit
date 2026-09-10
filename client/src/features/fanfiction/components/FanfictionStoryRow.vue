<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Check, LoaderCircle, MoreHorizontal } from '@lucide/vue'
import type { FanfictionJob, FanfictionSource } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import StoryUpdateOutcome from './StoryUpdateOutcome.vue'
import StoryReadingActions from './StoryReadingActions.vue'
import ImportProgress from './ImportProgress.vue'

const props = defineProps<{
  source: FanfictionSource
  job?: FanfictionJob
  error?: string
  pending: boolean
  disabled: boolean
  selectionDisabled: boolean
  selected: boolean
}>()
const emit = defineEmits<{ select: [selected: boolean]; check: []; refresh: []; pause: [] }>()
const { t, locale } = useI18n()
const active = computed(() => props.pending || ['queued', 'running'].includes(props.job?.state ?? ''))
const canCheck = computed(
  () => props.source.bookFileId && props.source.attentionCode !== 'destination_profile_required' && ['active', 'paused'].includes(props.source.state),
)
const needsAttention = computed(
  () => Boolean(props.source.attentionCode) || ['review_required', 'configuration_blocked'].includes(props.source.state),
)
const details = computed(() => ({ name: 'book-detail', params: { bookId: props.source.bookId }, query: { tab: 'story-updates' } }))
const succeeded = computed(() => props.job && ['succeeded', 'no_change'].includes(props.job.state))
const outcome = computed(() =>
  props.job?.state === 'no_change' || props.job?.result?.noChange ? t('fanfiction.noNewChapters') : t('fanfiction.storyUpdated'),
)
const words = computed(() => (props.source.wordCount === null ? '' : new Intl.NumberFormat(locale.value).format(props.source.wordCount)))
const lastChecked = computed(() =>
  props.source.lastCheckedAt ? new Date(props.source.lastCheckedAt).toLocaleString(locale.value) : t('fanfiction.never'),
)
function handleSelect(event: Event) {
  emit('select', (event.target as HTMLInputElement).checked)
}
function handleCheck() {
  emit('check')
}
function handleRefresh() {
  emit('refresh')
}
function handlePause() {
  emit('pause')
}
</script>

<template>
  <article class="flex items-start gap-3 border-b border-border py-4 last:border-0 sm:gap-4">
    <label class="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md has-focus-visible:ring-2 has-focus-visible:ring-ring">
      <input
        type="checkbox"
        :checked="selected"
        :disabled="selectionDisabled"
        :aria-label="t('fanfiction.bulk.selectStory', { title: source.title })"
        class="size-4 accent-primary"
        @change="handleSelect"
      />
    </label>
    <div class="min-w-0 flex-1 space-y-2">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1 space-y-1">
          <h2 class="break-words text-base font-semibold">
            <RouterLink
              v-if="source.bookId"
              :to="{ name: 'book-detail', params: { bookId: source.bookId } }"
              class="rounded-sm hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >{{ source.title }}</RouterLink
            >
            <span v-else>{{ source.title }}</span>
          </h2>
          <p class="break-words text-sm text-muted-foreground">{{ source.authors.join(', ') }} · {{ source.site }}</p>
          <p class="text-sm text-muted-foreground">
            {{ t('fanfiction.chapterCount', { count: source.chapterCount })
            }}<span v-if="words"> · {{ t('fanfiction.wordCount', { count: words }) }}</span> · {{ source.storyStatus }}
          </p>
        </div>
        <DropdownMenu v-if="canCheck">
          <DropdownMenuTrigger as-child
            ><Button
              variant="ghost"
              class="size-11 shrink-0"
              :disabled="disabled || active"
              :aria-label="t('fanfiction.storyActions', { title: source.title })"
              ><MoreHorizontal aria-hidden="true" /></Button
          ></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem v-if="source.bookId" as-child>
              <RouterLink :to="details">{{ t('fanfiction.storyUpdates') }}</RouterLink>
            </DropdownMenuItem>
            <DropdownMenuItem v-if="source.attentionCode !== 'metadata_review_required'" @select="handleRefresh">{{
              t('fanfiction.refreshChapters')
            }}</DropdownMenuItem>
            <DropdownMenuItem v-if="source.attentionCode !== 'metadata_review_required'" @select="handlePause">{{
              source.state === 'paused' ? t('fanfiction.resumeUpdates') : t('fanfiction.pauseUpdates')
            }}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <StoryReadingActions
        v-if="source.bookId && source.bookFileId"
        :book-id="source.bookId"
        :book-file-id="source.bookFileId"
        :reading="source.reading"
      />
      <p v-if="source.sourceTitle && source.sourceTitle !== source.title" class="text-xs text-muted-foreground">{{ source.sourceTitle }}</p>
      <p v-if="source.attentionCode" class="text-sm text-destructive">{{ t(`fanfiction.errors.${source.attentionCode}`) }}</p>
      <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
      <div v-if="pending" role="status" class="flex items-center gap-2 text-sm">
        <LoaderCircle class="size-4 motion-safe:animate-spin" aria-hidden="true" />{{ t('fanfiction.checkingStory') }}
      </div>
      <p v-else-if="succeeded" role="status" class="flex items-center gap-2 text-sm">
        <Check class="size-4 text-primary" aria-hidden="true" />{{ outcome }}
      </p>
      <ImportProgress v-else-if="job" :job="job" />
      <StoryUpdateOutcome v-if="succeeded && job" :job="job" />
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button v-if="needsAttention && source.bookId" variant="outline" as-child
          ><RouterLink :to="details">{{
            t(source.attentionCode === 'metadata_review_required' ? 'fanfiction.metadataReview.title' : 'fanfiction.reviewStory')
          }}</RouterLink></Button
        >
        <Button v-else-if="source.attentionCode === 'import_review_required'" variant="outline" as-child
          ><RouterLink :to="{ name: 'fanfiction', query: { tab: 'activity', sourceId: source.id, libraryId: source.libraryId } }">{{
            t('fanfiction.previewStory')
          }}</RouterLink></Button
        >
        <Button v-else-if="needsAttention" variant="outline" as-child
          ><RouterLink :to="{ name: 'settings-fanfiction' }">{{ t('fanfiction.configureSource') }}</RouterLink></Button
        >
        <Button v-else-if="canCheck" variant="outline" :disabled="disabled || active" @click="handleCheck">{{ t('fanfiction.checkNow') }}</Button>
        <span class="text-xs text-muted-foreground">{{ t(`fanfiction.sourceStates.${source.state}`) }}</span>
        <span class="text-xs text-muted-foreground">{{ t('fanfiction.lastChecked') }}: {{ lastChecked }}</span>
      </div>
    </div>
  </article>
</template>

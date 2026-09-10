<script setup lang="ts">
import { computed, useId } from 'vue'
import { ChevronDown, ExternalLink } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { FanfictionDiscoveryCandidate, FanfictionDiscoveryWebsite, FanfictionProfileSummary } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import StorySchedule from './StorySchedule.vue'
import type { DiscoveryReview } from '../composables/useDiscoveryReview'
import { useWebsiteReview, comparisonMatches } from '../composables/useWebsiteReview'
import { discoverySources } from '../composables/discoveryReview'
const props = defineProps<{
  source: FanfictionDiscoveryWebsite
  cutoff: string
  review: DiscoveryReview
  profiles: FanfictionProfileSummary[]
  moreProfiles: boolean
}>()
const emit = defineEmits<{ moreProfiles: [] }>()
const { t } = useI18n()
const panelId = useId()
const {
  open,
  items,
  total,
  cursor,
  pageNumber,
  loading,
  error,
  selectionError,
  profile,
  schedule,
  sourceChoices,
  profileChoices,
  comparisons,
  selectedCount,
  all,
  busy,
  finished,
  uncheckedCount,
  targetJob,
  reviewable,
  isSelected,
  urlFor,
  toggleOpen,
  nextPage,
  previousPage,
  toggleAll,
  toggleBook,
  clearSelection,
  changeProfile,
  changeBook,
  compareBook,
  link,
  remaining,
} = useWebsiteReview(
  () => props.source,
  () => props.cutoff,
  props.review,
)
const websiteName = computed(() => props.source.website || t('fanfiction.discovery.websiteUnknown'))
const active = computed(() => targetJob.value && ['queued', 'running'].includes(targetJob.value.state))
function changeSource(book: FanfictionDiscoveryCandidate, event: Event) {
  sourceChoices.value[book.id] = (event.target as HTMLSelectElement).value
  changeBook(book)
}
function changeBookProfile(book: FanfictionDiscoveryCandidate, event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (value) profileChoices.value[book.id] = value
  else delete profileChoices.value[book.id]
  changeBook(book)
}
function loadMoreProfiles() {
  emit('moreProfiles')
}
function cancel() {
  void props.review.cancel()
}
function retry() {
  void props.review.retry(targetJob.value?.id)
}
</script>
<template>
  <section class="border-border rounded-lg border" :aria-label="websiteName">
    <h3>
      <button
        type="button"
        class="hover:bg-muted/50 focus-visible:ring-ring flex min-h-16 w-full items-center gap-3 rounded-lg p-4 text-left focus-visible:ring-2"
        :aria-expanded="open"
        :aria-controls="panelId"
        @click="toggleOpen"
      >
        <ChevronDown class="size-5 shrink-0 transition-transform" :class="{ '-rotate-90': !open }" aria-hidden="true" />
        <span class="min-w-0 flex-1">
          <span class="block break-words text-lg font-semibold">{{ websiteName }}</span>
          <span class="text-muted-foreground block text-sm font-normal"
            >{{ t('fanfiction.sourceReview.remainingCount', { count: total })
            }}<template v-if="source.linked"> · {{ t('fanfiction.sourceReview.linkedCount', { count: source.linked }) }}</template></span
          >
        </span>
        <span v-if="selectedCount" class="text-sm font-medium">{{ t('fanfiction.sourceReview.selected', { count: selectedCount }) }}</span>
      </button>
    </h3>
    <div v-if="targetJob" class="bg-muted mx-4 mb-4 space-y-2 rounded-md p-3 text-sm" role="status">
      <p v-if="active" class="font-medium">{{ t('fanfiction.sourceReview.linkingWebsite', { website: websiteName }) }}</p>
      <p v-else class="font-medium">{{ t(`fanfiction.states.${targetJob.state}`) }}</p>
      <p v-if="targetJob.result?.selection">{{ t('fanfiction.discovery.selectionProgress', targetJob.result.selection) }}</p>
      <p v-if="targetJob.errorCode" class="text-destructive">{{ t(`fanfiction.errors.${targetJob.errorCode}`) }}</p>
      <Button v-if="active" variant="outline" :disabled="review.busy.value || targetJob.cancellationRequested" @click="cancel">{{
        t('fanfiction.cancel')
      }}</Button>
      <Button
        v-else-if="['failed', 'cancelled', 'configuration_blocked'].includes(targetJob.state)"
        variant="outline"
        :disabled="review.locked.value"
        @click="retry"
        >{{ t('fanfiction.retry') }}</Button
      >
    </div>
    <div v-show="open" :id="panelId" class="space-y-4 px-4 pb-4">
      <div v-if="!finished" class="flex flex-wrap items-end gap-3">
        <label class="min-w-0 flex-1 space-y-1 text-sm">
          <span>{{ t('fanfiction.profile') }}</span>
          <select
            v-model="profile"
            :disabled="busy"
            class="border-input bg-background block min-h-11 w-full rounded-md border p-2"
            @change="changeProfile"
          >
            <option value="auto">{{ t('fanfiction.automaticProfile') }}</option>
            <option value="public">{{ t('fanfiction.noProfile') }}</option>
            <option v-for="option in profiles" :key="option.id" :value="option.id">{{ option.name }}</option>
          </select>
        </label>
        <StorySchedule v-model="schedule" :disabled="busy" />
        <Button v-if="moreProfiles" variant="ghost" :disabled="busy" @click="loadMoreProfiles">{{ t('fanfiction.moreProfiles') }}</Button>
      </div>
      <div v-if="!finished" class="border-border bg-background sticky top-0 z-10 space-y-2 border-y py-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <label class="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              :checked="all && selectedCount === total && total > 0"
              :indeterminate="selectedCount > 0 && !(all && selectedCount === total)"
              :disabled="busy || !total || finished"
              class="accent-primary size-4"
              @change="toggleAll"
            />
            {{ t('fanfiction.sourceReview.selectWebsite', { count: total }) }}
          </label>
          <Button :disabled="busy || !selectedCount || finished" @click="link">{{
            t('fanfiction.discovery.linkCount', { count: selectedCount })
          }}</Button>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span v-if="uncheckedCount" class="text-muted-foreground">{{ t('fanfiction.sourceReview.notCompared', { count: uncheckedCount }) }}</span>
          <span v-else class="text-muted-foreground">{{ t('fanfiction.sourceReview.confidentHelp') }}</span>
          <Button v-if="selectedCount" variant="ghost" :disabled="busy" @click="clearSelection">{{
            t('fanfiction.discovery.clearSelection')
          }}</Button>
        </div>
        <p v-if="!all && selectedCount >= 100" class="text-sm">{{ t('fanfiction.sourceReview.selectionLimit') }}</p>
      </div>
      <p v-if="selectionError" role="alert" class="text-destructive text-sm">{{ t(`fanfiction.sourceReview.${selectionError}`) }}</p>
      <p v-if="error" role="alert" class="text-destructive text-sm">{{ error }}</p>
      <p v-if="loading" role="status" class="text-muted-foreground py-6 text-sm">{{ t('fanfiction.discovery.loading') }}</p>
      <div v-if="finished" class="flex flex-wrap items-center justify-between gap-3 py-2">
        <p class="text-sm">{{ t('fanfiction.sourceReview.resultsKept') }}</p>
        <Button variant="outline" :disabled="busy" @click="remaining">{{ t('fanfiction.sourceReview.reviewRemaining', { count: total }) }}</Button>
      </div>
      <p v-if="!loading && !items.length" class="text-muted-foreground py-4 text-sm">{{ t('fanfiction.sourceReview.websiteDone') }}</p>
      <ul class="divide-border divide-y">
        <li v-for="book in items" :key="book.id" class="py-4">
          <div class="flex items-start gap-3">
            <label class="flex min-h-11 min-w-8 items-center justify-center">
              <input
                type="checkbox"
                :checked="isSelected(book)"
                :disabled="busy || finished || !reviewable(book) || (!all && selectedCount >= 100 && !isSelected(book))"
                :aria-label="t('fanfiction.discovery.selectBook', { title: book.title })"
                class="accent-primary size-4"
                @change="toggleBook(book)"
              />
            </label>
            <div class="min-w-0 flex-1 space-y-3">
              <dl class="grid gap-4 sm:grid-cols-2">
                <div class="min-w-0 space-y-1">
                  <dt class="text-muted-foreground text-sm">{{ t('fanfiction.sourceReview.localBook') }}</dt>
                  <dd>
                    <RouterLink :to="{ name: 'book-detail', params: { bookId: book.bookId } }" class="text-primary font-medium hover:underline">{{
                      book.title
                    }}</RouterLink>
                  </dd>
                  <dd class="text-sm">{{ book.authors.join(', ') || t('fanfiction.sourceReview.noAuthor') }}</dd>
                  <dd class="text-muted-foreground text-sm">{{ t('fanfiction.chapterCount', { count: book.chapterCount }) }}</dd>
                </div>
                <div class="min-w-0 space-y-1">
                  <dt class="text-muted-foreground text-sm">{{ t('fanfiction.sourceReview.remoteBook') }}</dt>
                  <template v-if="comparisons[book.id]?.remote">
                    <dd class="font-medium">{{ comparisons[book.id]!.remote!.title }}</dd>
                    <dd class="text-sm">{{ comparisons[book.id]!.remote!.authors.join(', ') || t('fanfiction.sourceReview.noAuthor') }}</dd>
                    <dd class="text-muted-foreground text-sm">
                      {{ t('fanfiction.chapterCount', { count: comparisons[book.id]!.remote!.chapterCount }) }}
                    </dd>
                    <dd class="text-sm font-medium">
                      {{
                        t(
                          comparisonMatches(book, comparisons[book.id]!.remote!)
                            ? 'fanfiction.sourceReview.matches'
                            : 'fanfiction.sourceReview.differs',
                        )
                      }}
                    </dd>
                  </template>
                  <dd v-else-if="comparisons[book.id]?.state === 'failed'" class="space-y-1 text-sm">
                    <p class="text-destructive">{{ comparisons[book.id]?.error }}</p>
                    <Button variant="outline" :disabled="busy" @click="compareBook(book)">{{ t('fanfiction.sourceReview.retryComparison') }}</Button>
                  </dd>
                  <dd v-else class="text-muted-foreground text-sm" role="status">
                    {{
                      t(
                        finished
                          ? 'fanfiction.sourceReview.notChecked'
                          : urlFor(book)
                            ? 'fanfiction.sourceReview.checking'
                            : 'fanfiction.discovery.chooseSource',
                      )
                    }}
                  </dd>
                </div>
              </dl>
              <a
                v-if="urlFor(book)"
                :href="urlFor(book)"
                target="_blank"
                rel="noopener noreferrer"
                class="text-primary inline-flex max-w-full items-start gap-1 break-all text-sm underline-offset-4 hover:underline"
                >{{ urlFor(book) }}<ExternalLink class="mt-1 size-3 shrink-0" aria-hidden="true"
              /></a>
              <p v-if="!reviewable(book)" class="text-sm font-medium">{{ t(`fanfiction.discovery.states.${book.state}`) }}</p>
              <p v-if="book.errorCode" class="text-destructive text-sm">{{ t(`fanfiction.errors.${book.errorCode}`) }}</p>
              <details v-if="reviewable(book)" :open="discoverySources(book).length !== 1 || book.profileMatch?.ambiguous">
                <summary class="text-muted-foreground min-h-11 cursor-pointer py-2 text-sm">{{ t('fanfiction.discovery.changeLink') }}</summary>
                <div class="grid gap-3 sm:grid-cols-2">
                  <label v-if="discoverySources(book).length !== 1" class="min-w-0 space-y-1 text-sm">
                    <span>{{ t('fanfiction.discovery.chooseSource') }}</span>
                    <select
                      :value="sourceChoices[book.id] ?? ''"
                      :disabled="busy || finished"
                      class="border-input bg-background block min-h-11 w-full rounded-md border p-2"
                      @change="changeSource(book, $event)"
                    >
                      <option value="">{{ t('fanfiction.discovery.chooseSource') }}</option>
                      <option v-for="url in discoverySources(book)" :key="url" :value="url">{{ url }}</option>
                    </select>
                  </label>
                  <label class="min-w-0 space-y-1 text-sm">
                    <span>{{ t('fanfiction.profile') }}</span>
                    <select
                      :value="profileChoices[book.id] ?? ''"
                      :disabled="busy || finished"
                      class="border-input bg-background block min-h-11 w-full rounded-md border p-2"
                      @change="changeBookProfile(book, $event)"
                    >
                      <option value="">{{ t('fanfiction.sourceReview.websiteProfile') }}</option>
                      <option value="public">{{ t('fanfiction.noProfile') }}</option>
                      <option v-for="option in profiles" :key="option.id" :value="option.id">{{ option.name }}</option>
                    </select>
                  </label>
                </div>
              </details>
            </div>
          </div>
        </li>
      </ul>
      <nav v-if="cursor || pageNumber > 1" class="flex flex-wrap items-center justify-between gap-3" :aria-label="t('fanfiction.discovery.pages')">
        <Button variant="outline" :disabled="busy || pageNumber === 1 || finished" @click="previousPage">{{
          t('fanfiction.discovery.previousPage')
        }}</Button>
        <span class="text-muted-foreground text-sm">{{ t('fanfiction.discovery.page', { page: pageNumber }) }}</span>
        <Button variant="outline" :disabled="busy || cursor === null || finished" @click="nextPage">{{ t('fanfiction.nextPage') }}</Button>
      </nav>
    </div>
  </section>
</template>

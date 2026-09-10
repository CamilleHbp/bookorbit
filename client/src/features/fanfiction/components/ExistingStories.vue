<script setup lang="ts">
import StorySchedule from './StorySchedule.vue'
import { computed, onMounted, ref } from 'vue'
import DiscoveryWebsiteGroup from './DiscoveryWebsiteGroup.vue'
import { groupDiscoveryByWebsite } from '../composables/discoveryReview'
import { useI18n } from 'vue-i18n'
import type { FanfictionProfileSummary } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { useFanfictionDiscovery } from '../composables/useFanfictionDiscovery'
const props = defineProps<{ libraryId: number; profiles: FanfictionProfileSummary[]; profileCursor: string | null }>()
const emit = defineEmits<{ moreProfiles: [] }>()
const profileId = defineModel<string>('profileId', { required: true })
const schedule = defineModel<string>('schedule', { required: true })
const { t } = useI18n()
const {
  items,
  total,
  urlPrefixesText,
  filterDirty,
  cursor,
  state,
  selected,
  allMatching,
  choices,
  profileChoices,
  job,
  busy,
  error,
  pending,
  active,
  locked,
  reviewable,
  canApprove,
  refresh,
  nextPage,
  previousPage,
  pageNumber,
  reviewBooks,
  recover,
  scan,
  review,
  cancel,
  retry,
  submitPending,
  selectPage,
} = useFanfictionDiscovery(props.libraryId)
const autoProfile = ref(true)
const profileChoice = computed({
  get: () => profileId.value || (autoProfile.value ? 'auto' : 'public'),
  set: (value: string) => {
    profileId.value = value === 'auto' || value === 'public' ? '' : value
    autoProfile.value = value !== 'public'
  },
})
const selectedProfileRoots = computed(() => props.profiles.find((profile) => profile.id === profileId.value)?.rootUrls ?? [])
async function useProfileUrls() {
  urlPrefixesText.value = selectedProfileRoots.value.join('\n')
  await refresh()
}
const bulkProfileName = computed(() =>
  profileId.value
    ? (props.profiles.find((profile) => profile.id === profileId.value)?.name ?? t('fanfiction.profile'))
    : t(autoProfile.value ? 'fanfiction.automaticProfile' : 'fanfiction.noProfile'),
)
async function changeBulkProfile() {
  allMatching.value = false
  if (selectedProfileRoots.value.length) await useProfileUrls()
}
const hasBookChoices = computed(() =>
  items.value.some((item) => Boolean(choices.value[item.id]) || Boolean(profileChoices.value[item.id] && profileChoices.value[item.id] !== 'auto')),
)
const groups = computed(() => groupDiscoveryByWebsite(items.value))
const approve = () => review('approve', allMatching.value ? profileId.value : '', schedule.value, allMatching.value ? autoProfile.value : true)
const linkBooks = (ids: string[], profile: string, source?: string) => reviewBooks(ids, profile, schedule.value, source)
async function filterWebsite(website: string) {
  urlPrefixesText.value = `https://${website}\nhttps://www.${website}`
  await refresh()
}
async function clearFilter() {
  urlPrefixesText.value = ''
  await refresh()
}
function clearSelection() {
  allMatching.value = false
  selected.value = []
}
const reject = () => review('reject', '', 'manual')
function moreProfiles() {
  emit('moreProfiles')
}
onMounted(recover)
</script>
<template>
  <section class="space-y-4">
    <div class="flex flex-wrap gap-2">
      <Button :disabled="locked" @click="scan">{{ t('fanfiction.discovery.findLinks') }}</Button>
      <Button variant="outline" :disabled="busy || pending !== null" @click="refresh">{{ t('fanfiction.refresh') }}</Button>
    </div>
    <p v-if="error" role="alert" class="text-destructive text-sm">{{ error }}</p>
    <div v-if="pending" class="border-border space-y-2 rounded-md border p-3">
      <p class="text-sm">{{ t('fanfiction.discovery.uncertain') }}</p>
      <Button :disabled="busy" @click="submitPending">{{ t('fanfiction.retry') }}</Button>
    </div>
    <article v-if="job" class="border-border bg-card space-y-2 rounded-md border p-4" aria-live="polite">
      <p class="font-medium">{{ t(`fanfiction.kinds.${job.kind}`) }} · {{ t(`fanfiction.states.${job.state}`) }}</p>
      <p v-if="job.result?.discovery" class="text-sm">{{ t('fanfiction.discovery.scanProgress', job.result.discovery) }}</p>
      <p v-if="job.result?.selection" class="text-sm">{{ t('fanfiction.discovery.selectionProgress', job.result.selection) }}</p>
      <p v-if="job.errorCode" class="text-destructive text-sm">{{ t(`fanfiction.errors.${job.errorCode}`) }}</p>
      <Button v-if="active" variant="outline" :disabled="busy || job.cancellationRequested" @click="cancel">{{ t('fanfiction.cancel') }}</Button>
      <Button
        v-else-if="['failed', 'cancelled', 'configuration_blocked', 'review_required'].includes(job.state)"
        variant="outline"
        :disabled="busy"
        @click="retry"
        >{{ t('fanfiction.retry') }}</Button
      >
    </article>
    <div class="flex flex-wrap items-end justify-between gap-3">
      <label class="block space-y-1 text-sm">
        <span>{{ t('fanfiction.status') }}</span>
        <select v-model="state" :disabled="locked" class="border-input bg-background min-h-11 rounded-md border p-2" @change="refresh">
          <option v-for="value in ['pending', 'ambiguous', 'failed', 'linked', 'rejected']" :key="value" :value="value">
            {{ t(`fanfiction.discovery.states.${value}`) }}
          </option>
        </select>
      </label>
      <p class="text-muted-foreground text-sm">{{ t('fanfiction.discovery.pageScope', { page: pageNumber, count: items.length }) }}</p>
    </div>
    <div v-if="urlPrefixesText" class="bg-muted flex flex-wrap items-center justify-between gap-2 rounded-md p-3">
      <p class="min-w-0 break-all text-sm">{{ t('fanfiction.discovery.filteredBy') }}: {{ urlPrefixesText.split('\n').join(', ') }}</p>
      <Button variant="ghost" :disabled="locked" @click="clearFilter">{{ t('fanfiction.discovery.allWebsites') }}</Button>
    </div>
    <details class="border-border rounded-md border p-3">
      <summary class="min-h-11 cursor-pointer py-2 text-sm font-medium">{{ t('fanfiction.discovery.filterAndSettings') }}</summary>
      <div class="space-y-4 pt-3">
        <form class="space-y-2" @submit.prevent="refresh">
          <label class="block space-y-1 text-sm">
            <span>{{ t('fanfiction.urlPrefixFilter') }}</span>
            <textarea
              v-model="urlPrefixesText"
              :disabled="locked"
              rows="2"
              maxlength="81939"
              class="border-input bg-background block w-full rounded-md border p-2"
            />
          </label>
          <Button type="submit" variant="outline" :disabled="locked">{{ t('fanfiction.applyUrlFilter') }}</Button>
        </form>
        <div class="flex flex-wrap items-end gap-3">
          <label class="block space-y-1 text-sm">
            <span>{{ t('fanfiction.discovery.bulkProfile') }}</span>
            <select
              @change="changeBulkProfile"
              v-model="profileChoice"
              :disabled="locked"
              class="border-input bg-background block min-h-11 rounded-md border p-2"
            >
              <option value="auto">{{ t('fanfiction.automaticProfile') }}</option>
              <option value="public">{{ t('fanfiction.noProfile') }}</option>
              <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
            </select>
          </label>
          <Button v-if="profileCursor" variant="outline" :disabled="locked" @click="moreProfiles">{{ t('fanfiction.moreProfiles') }}</Button>
          <Button variant="outline" :disabled="locked || !selectedProfileRoots.length" @click="useProfileUrls">{{
            t('fanfiction.discovery.filterProfileWebsites')
          }}</Button>
          <StorySchedule v-model="schedule" :disabled="locked" />
        </div>
        <label v-if="reviewable && state !== 'ambiguous'" class="flex min-h-11 items-center gap-2 text-sm">
          <input
            v-model="allMatching"
            type="checkbox"
            :disabled="locked || filterDirty || !items.length || hasBookChoices"
            class="accent-primary size-4"
          />{{ t('fanfiction.discovery.allMatching') }}
        </label>
        <p class="text-muted-foreground text-sm">
          {{ t(hasBookChoices ? 'fanfiction.discovery.linkReviewedFirst' : 'fanfiction.discovery.bulkHelp') }}
        </p>
      </div>
    </details>
    <div v-if="reviewable && items.length" class="bg-background border-border sticky top-0 z-10 space-y-2 border-b py-3" aria-live="polite">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="font-medium">
            {{ allMatching ? t('fanfiction.discovery.allMatching') : t('fanfiction.discovery.selectedCount', { count: selected.length }) }}
          </p>
          <p v-if="allMatching" class="text-muted-foreground text-sm">{{ t('fanfiction.discovery.bulkSettings', { profile: bulkProfileName }) }}</p>
        </div>
        <Button :disabled="locked || !canApprove" @click="approve">{{
          allMatching
            ? total === null
              ? t('fanfiction.discovery.linkAllFiltered')
              : t('fanfiction.discovery.linkAllCount', { count: total })
            : t('fanfiction.discovery.linkCount', { count: selected.length })
        }}</Button>
      </div>
      <details>
        <summary class="text-muted-foreground min-h-11 cursor-pointer py-2 text-sm">{{ t('fanfiction.discovery.selectionActions') }}</summary>
        <div class="flex flex-wrap gap-2">
          <Button variant="ghost" :disabled="locked || filterDirty" @click="selectPage">{{ t('fanfiction.discovery.selectReady') }}</Button>
          <Button variant="ghost" :disabled="locked || (!allMatching && !selected.length)" @click="clearSelection">{{
            t('fanfiction.discovery.clearSelection')
          }}</Button>
          <Button variant="ghost" :disabled="locked || filterDirty || (!allMatching && !selected.length)" @click="reject">{{
            t('fanfiction.discovery.reject')
          }}</Button>
        </div>
      </details>
    </div>
    <p v-if="busy && !items.length" role="status" class="text-muted-foreground py-8 text-sm">{{ t('fanfiction.discovery.loading') }}</p>
    <div v-else-if="!items.length && !error" class="space-y-2 py-8">
      <h3 class="font-medium">{{ t(urlPrefixesText ? 'fanfiction.discovery.noFilteredBooks' : 'fanfiction.discovery.noBooks') }}</h3>
      <p class="text-muted-foreground text-sm">{{ t(urlPrefixesText ? 'fanfiction.discovery.changeFilter' : 'fanfiction.discovery.scanHelp') }}</p>
    </div>
    <div class="space-y-8">
      <DiscoveryWebsiteGroup
        v-for="group in groups"
        :key="group.website"
        v-model:selected="selected"
        v-model:source-choices="choices"
        v-model:profile-choices="profileChoices"
        :website="group.website"
        :books="group.books"
        :profiles="profiles"
        :locked="locked || filterDirty"
        :reviewable="reviewable"
        :all-matching="allMatching"
        @link="linkBooks"
        @filter="filterWebsite"
      />
    </div>
    <nav v-if="cursor || pageNumber > 1" class="flex items-center justify-between gap-3" :aria-label="t('fanfiction.discovery.pages')">
      <Button variant="outline" :disabled="locked || filterDirty || pageNumber === 1" @click="previousPage">{{
        t('fanfiction.discovery.previousPage')
      }}</Button>
      <span class="text-muted-foreground text-sm">{{ t('fanfiction.discovery.page', { page: pageNumber }) }}</span>
      <Button variant="outline" :disabled="locked || filterDirty || !cursor" @click="nextPage">{{ t('fanfiction.nextPage') }}</Button>
    </nav>
  </section>
</template>

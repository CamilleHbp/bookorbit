<script setup lang="ts">
import StorySchedule from './StorySchedule.vue'
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
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
  urlPrefixesText,
  filterDirty,
  cursor,
  state,
  selected,
  allMatching,
  choices,
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
const approve = () => review('approve', profileId.value, schedule.value, autoProfile.value)
const reject = () => review('reject', '', 'manual')
function moreProfiles() {
  emit('moreProfiles')
}
onMounted(recover)
</script>
<template>
  <section class="space-y-4">
    <p class="text-muted-foreground text-sm">{{ t('fanfiction.discovery.help') }}</p>
    <div class="flex flex-wrap gap-2">
      <Button :disabled="locked" @click="scan">{{ t('fanfiction.discovery.scan') }}</Button>
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
    <label class="block text-sm"
      >{{ t('fanfiction.status') }}
      <select v-model="state" :disabled="locked" class="border-input bg-background ml-2 rounded-md border p-2" @change="refresh">
        <option v-for="value in ['pending', 'ambiguous', 'failed', 'linked', 'rejected']" :key="value" :value="value">
          {{ t(`fanfiction.discovery.states.${value}`) }}
        </option>
      </select>
    </label>
    <form class="space-y-2" @submit.prevent="refresh">
      <label class="block space-y-1 text-sm"
        ><span>{{ t('fanfiction.urlPrefixFilter') }}</span>
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
    <div v-if="reviewable" class="border-border space-y-3 rounded-md border p-3">
      <div class="flex flex-wrap items-center gap-3">
        <Button variant="outline" :disabled="locked || filterDirty || !items.length" @click="selectPage">{{
          t('fanfiction.discovery.selectPage')
        }}</Button>
        <label class="flex items-center gap-2 text-sm"
          ><input v-model="allMatching" type="checkbox" :disabled="locked || filterDirty" />{{ t('fanfiction.discovery.allMatching') }}</label
        >
      </div>
      <p v-if="allMatching" class="text-muted-foreground text-sm">{{ t('fanfiction.discovery.cutoffHelp') }}</p>
      <div class="flex flex-wrap items-end gap-3">
        <label class="text-sm"
          >{{ t('fanfiction.profile')
          }}<select v-model="profileChoice" :disabled="locked" class="border-input bg-background block rounded-md border p-2">
            <option value="auto">{{ t('fanfiction.automaticProfile') }}</option>
            <option value="public">{{ t('fanfiction.noProfile') }}</option>
            <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
          </select></label
        >
        <Button v-if="profileCursor" variant="outline" :disabled="locked" @click="moreProfiles">{{ t('fanfiction.moreProfiles') }}</Button>
        <Button variant="outline" :disabled="locked || !selectedProfileRoots.length" @click="useProfileUrls">{{
          t('fanfiction.useProfileUrls')
        }}</Button>
        <StorySchedule v-model="schedule" :disabled="locked" />
        <Button :disabled="locked || !canApprove" @click="approve">{{ t('fanfiction.discovery.link') }}</Button>
        <Button variant="outline" :disabled="locked || filterDirty || (!allMatching && !selected.length)" @click="reject">{{
          t('fanfiction.discovery.reject')
        }}</Button>
      </div>
    </div>
    <p v-if="!items.length && !busy" class="text-muted-foreground text-sm">{{ t('fanfiction.discovery.empty') }}</p>
    <article v-for="item in items" :key="item.id" class="border-border bg-card space-y-2 rounded-md border p-4">
      <div class="flex items-start gap-3">
        <input
          v-if="reviewable"
          v-model="selected"
          :value="item.id"
          type="checkbox"
          :disabled="locked || filterDirty || allMatching"
          :aria-label="t('fanfiction.discovery.selectBook', { title: item.title })"
          class="mt-1"
        />
        <div class="min-w-0">
          <RouterLink :to="{ name: 'book-detail', params: { bookId: item.bookId } }" class="text-primary font-medium hover:underline">{{
            item.title || t('fanfiction.openBook')
          }}</RouterLink>
          <p class="text-muted-foreground text-sm">
            {{ item.authors.join(', ') }} · {{ t('fanfiction.chapterCount', { count: item.chapterCount }) }}
          </p>
        </div>
      </div>
      <p v-if="!profileId && autoProfile && item.profileMatch" class="text-sm">
        {{ t('fanfiction.profile') }}:
        {{ item.profileMatch.ambiguous ? t('fanfiction.errors.profile_ambiguous') : (item.profileMatch.profile?.name ?? t('fanfiction.noProfile')) }}
      </p>
      <p v-if="item.errorCode" class="text-destructive text-sm">{{ t(`fanfiction.errors.${item.errorCode}`) }}</p>
      <label v-if="item.state === 'ambiguous' || item.state === 'failed'" class="block text-sm"
        >{{ t('fanfiction.discovery.chooseSource') }}
        <select
          v-model="choices[item.id]"
          :disabled="locked || filterDirty || allMatching"
          class="border-input bg-background block w-full rounded-md border p-2"
        >
          <option value="">{{ t('fanfiction.discovery.chooseSource') }}</option>
          <template v-for="url in item.urls" :key="url.url"
            ><option v-if="url.recognized" :value="url.canonicalUrl">{{ url.canonicalUrl }}</option></template
          >
        </select>
      </label>
      <p v-for="url in item.urls" :key="url.url" class="text-muted-foreground break-all text-xs">{{ url.recognized ? url.canonicalUrl : url.url }}</p>
    </article>
    <Button v-if="cursor" variant="outline" :disabled="locked || filterDirty" @click="nextPage">{{ t('fanfiction.nextPage') }}</Button>
  </section>
</template>

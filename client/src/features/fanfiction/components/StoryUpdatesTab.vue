<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import type { useBookStory } from '../composables/useBookStory'

const props = defineProps<{ state: ReturnType<typeof useBookStory> }>()
const { t } = useI18n()
const {
  allowed,
  loading,
  error,
  sources,
  sourceId,
  source,
  sourceCursor,
  profiles,
  profileCursor,
  profileId,
  interval,
  revisions,
  revisionCursor,
  currentRevisionId,
  job,
  busy,
  refresh,
  selectSource,
  updateSettings,
  pause,
  unlink,
  checkNow,
  refreshChapters,
  retryJob,
  rollback,
  olderRevisions,
  moreProfiles,
  moreSources,
} = props.state
const manual = computed({
  get: () => interval.value === 'manual',
  set: (value: boolean) => {
    interval.value = value ? 'manual' : '1440'
  },
})
const profileMissing = computed(() => profileId.value && !profiles.value.some((profile) => profile.id === profileId.value))
const updating = computed(() => busy.value || (job.value !== null && ['queued', 'running'].includes(job.value.state)))
const canUpdate = computed(() => source.value && ['active', 'paused'].includes(source.value.state))
function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString() : t('fanfiction.never')
}
onMounted(refresh)
</script>

<template>
  <section v-if="allowed" class="mx-auto max-w-4xl space-y-5">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-xl font-semibold">{{ t('fanfiction.storyUpdates') }}</h1>
      <Button variant="outline" :disabled="busy" @click="refresh">{{ t('fanfiction.refresh') }}</Button>
    </header>
    <p v-if="error" role="alert" class="text-destructive text-sm">{{ error }}</p>
    <p v-if="loading" role="status" class="text-muted-foreground">{{ t('common.loading') }}</p>
    <div v-if="!sources.length" class="space-y-3">
      <p class="text-muted-foreground">{{ t('fanfiction.noManagedSource') }}</p>
      <RouterLink :to="{ name: 'fanfiction' }" class="text-primary underline">{{ t('fanfiction.title') }}</RouterLink>
    </div>
    <template v-if="source">
      <select
        v-if="sources.length > 1"
        v-model="sourceId"
        :aria-label="t('fanfiction.stories')"
        class="border-input bg-background w-full rounded-md border p-2"
        @change="selectSource"
      >
        <option v-for="item in sources" :key="item.id" :value="item.id">{{ item.title }}</option>
      </select>
      <div class="border-border bg-card space-y-3 rounded-xl border p-4">
        <a :href="source.canonicalUrl" target="_blank" rel="noopener noreferrer" class="text-primary break-words underline">{{
          source.canonicalUrl
        }}</a>
        <p>
          {{ source.storyStatus }} · {{ t('fanfiction.chapterCount', { count: source.chapterCount }) }} ·
          {{ t(`fanfiction.sourceStates.${source.state}`) }}
        </p>
        <p v-if="source.attentionCode" class="text-destructive text-sm">{{ t(`fanfiction.errors.${source.attentionCode}`) }}</p>
        <dl class="text-muted-foreground grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt>{{ t('fanfiction.lastChecked') }}</dt>
            <dd>{{ dateLabel(source.lastCheckedAt) }}</dd>
          </div>
          <div>
            <dt>{{ t('fanfiction.lastUpdated') }}</dt>
            <dd>{{ dateLabel(source.lastUpdatedAt) }}</dd>
          </div>
          <div>
            <dt>{{ t('fanfiction.nextCheck') }}</dt>
            <dd>{{ source.intervalMinutes === null ? t('fanfiction.manualOnly') : dateLabel(source.nextCheckAt) }}</dd>
          </div>
        </dl>
        <div class="flex flex-wrap gap-2">
          <Button v-if="canUpdate" :disabled="updating" @click="checkNow">{{ t('fanfiction.checkNow') }}</Button>
          <Button v-if="canUpdate" variant="outline" :disabled="updating" @click="refreshChapters">{{ t('fanfiction.refreshChapters') }}</Button>
          <Button v-if="canUpdate" variant="outline" :disabled="busy" @click="pause">{{
            source.state === 'paused' ? t('fanfiction.resumeUpdates') : t('fanfiction.pauseUpdates')
          }}</Button>
          <Button variant="outline" :disabled="updating" @click="unlink">{{ t('fanfiction.unlink') }}</Button>
        </div>
        <p class="text-muted-foreground text-xs">{{ t('fanfiction.unlinkHelp') }}</p>
      </div>
      <form class="border-border space-y-3 rounded-xl border p-4" @submit.prevent="updateSettings">
        <label class="block space-y-1 text-sm"
          >{{ t('fanfiction.profile') }}
          <select v-model="profileId" :disabled="updating" class="border-input bg-background block w-full rounded-md border p-2">
            <option value="">{{ t('fanfiction.noProfile') }}</option>
            <option v-if="profileMissing" :value="profileId">{{ t('fanfiction.currentProfile') }}</option>
            <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
          </select>
        </label>
        <Button v-if="profileCursor" type="button" variant="outline" :disabled="busy" @click="moreProfiles">{{
          t('fanfiction.moreProfiles')
        }}</Button>
        <label class="flex items-center gap-2 text-sm"
          ><input v-model="manual" :disabled="updating" type="checkbox" />{{ t('fanfiction.manualOnly') }}</label
        >
        <label v-if="!manual" class="block space-y-1 text-sm"
          >{{ t('fanfiction.intervalMinutes') }}
          <input
            v-model="interval"
            :disabled="updating"
            type="number"
            min="60"
            max="525600"
            class="border-input bg-background block w-full rounded-md border p-2"
          />
        </label>
        <div class="flex flex-wrap items-center gap-3">
          <Button type="submit" :disabled="updating">{{ t('common.save') }}</Button>
          <RouterLink :to="{ name: 'settings-fanfiction' }" class="text-primary text-sm underline">{{ t('fanfiction.settingsTitle') }}</RouterLink>
        </div>
      </form>
      <div v-if="job" role="status" class="border-border rounded-xl border p-4 text-sm">
        {{ t(`fanfiction.kinds.${job.kind}`) }} · {{ t(`fanfiction.states.${job.state}`) }}
        <p v-if="job.errorCode" class="text-destructive">{{ t(`fanfiction.errors.${job.errorCode}`) }}</p>
        <Button
          v-if="['failed', 'cancelled', 'configuration_blocked', 'review_required'].includes(job.state)"
          variant="outline"
          :disabled="updating"
          @click="retryJob"
          >{{ t('fanfiction.retry') }}</Button
        >
        <p class="text-muted-foreground">{{ t('fanfiction.serverActivityHelp') }}</p>
      </div>
      <section class="border-border space-y-3 rounded-xl border p-4">
        <h2 class="font-semibold">{{ t('book.detail.files.revisions.title') }}</h2>
        <p class="text-muted-foreground text-sm">{{ t('fanfiction.rollbackHelp') }}</p>
        <article
          v-for="revision in revisions"
          :key="revision.revision"
          class="border-border flex flex-wrap items-center justify-between gap-3 border-t pt-3"
        >
          <div class="text-sm">
            <p>
              {{ t(`book.detail.files.revisions.${revision.changeKind}`)
              }}<span v-if="revision.reason === 'rollback'"> · {{ t('fanfiction.kinds.rollback') }}</span
              ><span v-if="revision.revision === currentRevisionId"> · {{ t('fanfiction.currentRevision') }}</span>
            </p>
            <p class="text-muted-foreground">{{ dateLabel(revision.createdAt) }}</p>
          </div>
          <Button v-if="revision.canRollback" variant="outline" :disabled="updating" @click="rollback(revision)">{{
            t('fanfiction.rollback')
          }}</Button>
        </article>
        <Button v-if="revisionCursor" variant="outline" :disabled="busy" @click="olderRevisions">{{ t('book.detail.files.revisions.older') }}</Button>
      </section>
    </template>
    <Button v-if="sourceCursor" variant="outline" :disabled="busy" @click="moreSources">{{ t('fanfiction.nextPage') }}</Button>
  </section>
</template>

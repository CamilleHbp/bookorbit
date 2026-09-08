<script setup lang="ts">
import ImportProgress from './components/ImportProgress.vue'
import StoryPreviewModal from './components/StoryPreviewModal.vue'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Permission, type FanfictionJob, type FanfictionProfileSummary } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import StoryBulkActions from './components/StoryBulkActions.vue'
import { useFanfictionSourceBatch } from './composables/useFanfictionSourceBatch'
import ExistingStories from './components/ExistingStories.vue'
import SourceProfiles from './components/SourceProfiles.vue'
import SourceProfileEditor from './components/SourceProfileEditor.vue'
import { useInlineSourceSettings } from './composables/useInlineSourceSettings'
import { useFanfiction } from './composables/useFanfiction'

const { t } = useI18n()
const { hasPermission } = usePermissions()
const canManage = computed(() => hasPermission(Permission.ManageLibraries))
const {
  libraries,
  libraryCursor,
  libraryId,
  folders,
  folderCursor,
  folderId,
  profiles,
  profileCursor,
  profileId,
  sources,
  sourceCursor,
  jobs,
  jobCursor,
  activity,
  activityCursor,
  moreActivity,
  candidates,
  urls,
  search,
  state,
  schedule,
  busy,
  error,
  tab,
  loadLibraries,
  changeLibrary,
  moreFolders,
  moreProfiles,
  refresh,
  moreSources,
  moreJobs,
  reviewStories,
  reviewCandidate,
  confirmReview,
  dismissReview,
  reopenReview,
  retryImport,
  useSavedProfile,
  cancelJob,
  retryJob,
  togglePaused,
  checkNow,
  refreshChapters,
  showStories,
  showAdd,
  showActivity,
  showDiscovery,
} = useFanfiction()
const { sourceSettings, detectedSite, selectedProfile, addSource, editSource } = useInlineSourceSettings(libraryId, profiles, profileId, urls)
const configuring = ref<(typeof candidates.value)[number] | null>(null)
function handleAddSource() {
  configuring.value = null
  addSource()
}
async function configureImport(candidate: (typeof candidates.value)[number]) {
  const override = profiles.value.find((item) => item.id === profileId.value)
  if (override && override.id !== candidate.resolvedProfileId) {
    await retryImport(candidate, override)
    return
  }
  configuring.value = candidate
  const profile = profiles.value.find((item) => item.id === candidate.resolvedProfileId)
  if (profile) await sourceSettings.editProfile(profile)
  else addSource(candidate.url)
}
async function handleProfileSaved(profile: FanfictionProfileSummary) {
  const candidate = configuring.value
  configuring.value = null
  if (profile.libraryId !== libraryId.value) return
  if (candidate) await retryImport(candidate, profile)
  else useSavedProfile(profile)
}
function showProfiles() {
  tab.value = 'profiles'
}
function handleRefresh() {
  if (tab.value === 'profiles') void sourceSettings.reload()
  else void refresh()
}
watch(libraryId, () => {
  configuring.value = null
})
watch([tab, libraryId], ([activeTab, id]) => {
  if (activeTab === 'profiles' && id !== null) void sourceSettings.reload()
})
function handleProfileDeleted(id: string) {
  profiles.value = profiles.value.filter((profile) => profile.id !== id)
  if (profileId.value === id) profileId.value = ''
}
const bulk = reactive(useFanfictionSourceBatch(libraryId, sources, search, state, refresh))
function reviewBatch(job: FanfictionJob) {
  showStories()
  void bulk.open(job.id)
}
function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString() : t('fanfiction.never')
}
onMounted(() => {
  if (canManage.value) void loadLibraries()
})
</script>

<template>
  <main v-if="canManage" class="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">{{ t('fanfiction.title') }}</h1>
        <p class="text-muted-foreground text-sm">{{ t('fanfiction.description') }}</p>
      </div>
      <Button variant="outline" as-child
        ><RouterLink :to="{ name: 'settings-fanfiction' }">{{ t('fanfiction.settingsTitle') }}</RouterLink></Button
      >
    </header>
    <div class="flex flex-wrap items-end gap-3">
      <label class="min-w-48 space-y-1 text-sm"
        >{{ t('fanfiction.library') }}
        <select v-model="libraryId" :disabled="busy" class="border-input bg-background block w-full rounded-md border p-2" @change="changeLibrary">
          <option v-for="library in libraries" :key="library.id" :value="library.id">{{ library.name }}</option>
        </select>
      </label>
      <Button v-if="libraryCursor !== null" variant="outline" :disabled="busy" @click="loadLibraries">{{ t('fanfiction.moreLibraries') }}</Button>
      <Button variant="outline" :disabled="busy || sourceSettings.busy || libraryId === null" @click="handleRefresh">{{
        t('fanfiction.refresh')
      }}</Button>
    </div>
    <p v-if="!libraries.length && !busy" class="text-muted-foreground">{{ t('fanfiction.noLibraries') }}</p>
    <p v-if="error" role="alert" class="border-destructive text-destructive rounded-md border p-3 text-sm">{{ error }}</p>
    <template v-if="libraryId !== null">
      <nav class="flex flex-wrap gap-2" :aria-label="t('fanfiction.title')">
        <Button :variant="tab === 'stories' ? 'default' : 'outline'" @click="showStories">{{ t('fanfiction.stories') }}</Button>
        <Button :variant="tab === 'add' ? 'default' : 'outline'" @click="showAdd">{{ t('fanfiction.addStories') }}</Button>
        <Button :variant="tab === 'discovery' ? 'default' : 'outline'" @click="showDiscovery">{{ t('fanfiction.discovery.title') }}</Button>
        <Button :variant="tab === 'activity' ? 'default' : 'outline'" @click="showActivity">{{ t('fanfiction.activity') }}</Button>
        <Button :variant="tab === 'profiles' ? 'default' : 'outline'" @click="showProfiles">{{ t('fanfiction.profiles') }}</Button>
      </nav>
      <div v-if="tab === 'profiles'" class="space-y-4">
        <p v-if="sourceSettings.error" role="alert" class="text-sm text-destructive">{{ sourceSettings.error }}</p>
        <SourceProfiles :settings="sourceSettings" @saved="useSavedProfile" @deleted="handleProfileDeleted" />
      </div>
      <section v-if="tab === 'stories'" class="space-y-4">
        <form class="flex flex-wrap gap-3" @submit.prevent="refresh">
          <input
            v-model="search"
            :aria-label="t('fanfiction.search')"
            :placeholder="t('fanfiction.search')"
            maxlength="200"
            class="border-input bg-background min-w-48 rounded-md border p-2"
          />
          <select v-model="state" :aria-label="t('fanfiction.status')" class="border-input bg-background rounded-md border p-2" @change="refresh">
            <option value="">{{ t('fanfiction.allStates') }}</option>
            <option value="active">{{ t('fanfiction.sourceStates.active') }}</option>
            <option value="paused">{{ t('fanfiction.sourceStates.paused') }}</option>
            <option value="review_required">{{ t('fanfiction.states.review_required') }}</option>
            <option value="configuration_blocked">{{ t('fanfiction.states.configuration_blocked') }}</option>
          </select>
          <Button type="submit" variant="outline" :disabled="busy">{{ t('fanfiction.search') }}</Button>
        </form>
        <StoryBulkActions
          v-model:all-matching="bulk.allMatching"
          v-model:action="bulk.action"
          v-model:interval="bulk.interval"
          :bulk="bulk"
          :loading="busy"
        />
        <p v-if="!sources.length" class="text-muted-foreground text-sm">{{ t('fanfiction.noStories') }}</p>
        <article v-for="source in sources" :key="source.id" class="border-border bg-card grid gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_auto]">
          <div class="min-w-0 space-y-1">
            <label class="text-muted-foreground flex items-center gap-2 text-sm">
              <input v-model="bulk.selectedIds" type="checkbox" :value="source.id" :disabled="busy || bulk.busy || bulk.active || bulk.allMatching" />
              {{ t('fanfiction.bulk.selectStory', { title: source.title }) }}
            </label>
            <RouterLink
              v-if="source.bookId"
              :to="{ name: 'book-detail', params: { bookId: source.bookId } }"
              class="text-primary font-medium hover:underline"
              >{{ source.title }}</RouterLink
            >
            <h2 v-else class="font-medium">{{ source.title }}</h2>
            <p class="text-muted-foreground text-sm">
              {{ source.authors.join(', ') }} · {{ source.site }} · {{ t('fanfiction.chapterCount', { count: source.chapterCount }) }}
              <span v-if="source.wordCount !== null"> · {{ t('fanfiction.wordCount', { count: source.wordCount }) }}</span>
            </p>
            <p class="text-sm">{{ t(`fanfiction.sourceStates.${source.state}`) }} · {{ source.storyStatus }}</p>
            <p v-if="source.attentionCode" class="text-destructive text-sm">{{ t(`fanfiction.errors.${source.attentionCode}`) }}</p>
            <dl class="text-muted-foreground grid gap-x-4 text-xs sm:grid-cols-2">
              <div>
                <dt class="inline">{{ t('fanfiction.lastChecked') }}:</dt>
                <dd class="inline">{{ dateLabel(source.lastCheckedAt) }}</dd>
              </div>
              <div>
                <dt class="inline">{{ t('fanfiction.nextCheck') }}:</dt>
                <dd class="inline">{{ source.intervalMinutes === null ? t('fanfiction.manualOnly') : dateLabel(source.nextCheckAt) }}</dd>
              </div>
            </dl>
          </div>
          <div
            v-if="source.bookFileId && source.attentionCode !== 'destination_profile_required' && ['active', 'paused'].includes(source.state)"
            class="flex flex-wrap items-start gap-2"
          >
            <Button variant="outline" :disabled="busy" @click="checkNow(source)">{{ t('fanfiction.checkNow') }}</Button>
            <Button variant="outline" :disabled="busy" @click="refreshChapters(source)">{{ t('fanfiction.refreshChapters') }}</Button>
            <Button
              v-if="source.state === 'active' || (source.state === 'paused' && source.bookFileId)"
              variant="outline"
              :disabled="busy"
              @click="togglePaused(source)"
              >{{ source.state === 'paused' ? t('fanfiction.resumeUpdates') : t('fanfiction.pauseUpdates') }}</Button
            >
          </div>
        </article>
        <Button v-if="sourceCursor" variant="outline" :disabled="busy" @click="moreSources">{{ t('fanfiction.nextPage') }}</Button>
      </section>
      <section v-else-if="tab === 'add'" class="space-y-4">
        <header class="space-y-1">
          <h2 class="text-lg font-medium">{{ t('fanfiction.addStories') }}</h2>
        </header>
        <label class="block space-y-1 text-sm"
          >{{ t('fanfiction.storyUrls')
          }}<textarea
            v-model="urls"
            :disabled="busy"
            rows="5"
            maxlength="65536"
            class="border-input bg-background block w-full rounded-md border p-3"
            :placeholder="t('fanfiction.urlsHelp')"
          />
        </label>

        <p v-if="detectedSite" class="text-sm text-muted-foreground">{{ detectedSite.name }}</p>
        <details class="space-y-3 rounded-lg border border-border p-3">
          <summary class="cursor-pointer text-sm font-medium">{{ t('fanfiction.importOptions') }}</summary>
          <div class="grid gap-4 pt-3 sm:grid-cols-2">
            <label class="space-y-1 text-sm"
              >{{ t('fanfiction.folder') }}
              <select v-model="folderId" :disabled="busy" class="border-input bg-background block w-full rounded-md border p-2">
                <option v-for="folder in folders" :key="folder.id" :value="folder.id">{{ folder.path }}</option>
              </select>
            </label>
            <label class="space-y-1 text-sm"
              >{{ t('fanfiction.profile') }}
              <select v-model="profileId" :disabled="busy" class="border-input bg-background block w-full rounded-md border p-2">
                <option value="">{{ t('fanfiction.automaticProfile') }}</option>
                <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
              </select>
            </label>
            <label class="space-y-1 text-sm"
              >{{ t('fanfiction.schedule') }}
              <select v-model="schedule" :disabled="busy" class="border-input bg-background block w-full rounded-md border p-2">
                <option value="1440">{{ t('fanfiction.daily') }}</option>
                <option value="60">{{ t('fanfiction.hourly') }}</option>
                <option value="manual">{{ t('fanfiction.manualOnly') }}</option>
              </select>
            </label>
          </div>
          <div class="flex flex-wrap gap-2">
            <Button v-if="folderCursor !== null" variant="outline" :disabled="busy" @click="moreFolders">{{ t('fanfiction.moreFolders') }}</Button>
            <Button v-if="profileCursor" variant="outline" :disabled="busy" @click="moreProfiles">{{ t('fanfiction.moreProfiles') }}</Button>
            <Button variant="outline" :disabled="busy || sourceSettings.busy" @click="handleAddSource">{{ t('fanfiction.addProfile') }}</Button>
            <Button v-if="selectedProfile" variant="outline" :disabled="busy || sourceSettings.busy" @click="editSource">{{
              t('fanfiction.editSource')
            }}</Button>
          </div>
        </details>
        <p v-if="sourceSettings.error" role="alert" class="text-sm text-destructive">{{ sourceSettings.error }}</p>
        <SourceProfileEditor :settings="sourceSettings" :compact="configuring !== null" @saved="handleProfileSaved" />
        <Button :disabled="busy || sourceSettings.busy || sourceSettings.showEditor || !urls.trim() || folderId === null" @click="reviewStories">{{
          t('fanfiction.previewStory')
        }}</Button>
        <StoryPreviewModal
          v-if="reviewCandidate?.preview"
          :key="reviewCandidate.previewKey"
          :preview="reviewCandidate.preview"
          :busy="busy"
          :locked="!!reviewCandidate.importRequest"
          :error="error"
          @confirm="confirmReview"
          @cancel="dismissReview"
        />
        <article v-for="candidate in candidates" :key="candidate.previewKey" class="border-border bg-card space-y-2 rounded-lg border p-4">
          <p class="min-w-0 break-words font-medium">{{ candidate.preview?.title || candidate.url }}</p>
          <p v-if="candidate.preview" class="text-muted-foreground text-sm">
            {{ candidate.preview.authors.join(', ') }} · {{ t('fanfiction.chapterCount', { count: candidate.preview.chapterCount }) }} ·
            {{ candidate.preview.status }}
            <span v-if="candidate.preview.wordCount != null"> · {{ t('fanfiction.wordCount', { count: candidate.preview.wordCount }) }}</span>
          </p>
          <Button
            v-if="candidate.preview && candidate.job?.kind === 'preview' && candidate.job.state === 'succeeded'"
            variant="outline"
            :disabled="busy"
            @click="reopenReview(candidate)"
            >{{ t('fanfiction.previewStory') }}</Button
          >
          <ImportProgress v-if="candidate.job" :job="candidate.job" />
          <Button
            v-if="candidate.job && ['queued', 'running'].includes(candidate.job.state)"
            variant="outline"
            :disabled="busy || candidate.job.cancellationRequested"
            @click="cancelJob(candidate.job)"
            >{{ t('fanfiction.cancel') }}</Button
          >
          <template v-if="candidate.job && ['configuration_blocked', 'failed', 'cancelled'].includes(candidate.job.state)">
            <Button
              v-if="['authentication_required', 'configuration_blocked', 'access_denied'].includes(candidate.job.errorCode ?? '')"
              :disabled="busy || sourceSettings.busy"
              @click="configureImport(candidate)"
              >{{ t('fanfiction.configureSource') }}</Button
            >
            <Button v-else :disabled="busy" @click="retryImport(candidate)">{{ t('fanfiction.retry') }}</Button>
          </template>

          <RouterLink
            v-if="candidate.job?.result?.bookId"
            :to="{ name: 'book-detail', params: { bookId: candidate.job.result.bookId } }"
            class="text-primary text-sm underline"
            >{{ t('fanfiction.openBook') }}</RouterLink
          >
        </article>
      </section>
      <ExistingStories
        v-else-if="tab === 'discovery'"
        :key="libraryId"
        v-model:profile-id="profileId"
        v-model:schedule="schedule"
        :library-id="libraryId"
        :profiles="profiles"
        :profile-cursor="profileCursor"
        @more-profiles="moreProfiles"
      />
      <section v-else class="space-y-3">
        <h2 class="text-lg font-medium">{{ t('fanfiction.recentChanges') }}</h2>
        <article v-for="event in activity" :key="event.id" class="border-border bg-card rounded-lg border p-4">
          <p class="font-medium">{{ event.title }}</p>
          <p class="text-muted-foreground text-sm">{{ t(`fanfiction.activityKinds.${event.kind}`) }} · {{ dateLabel(event.createdAt) }}</p>
          <RouterLink v-if="event.bookId" :to="{ name: 'book-detail', params: { bookId: event.bookId } }" class="text-primary text-sm underline">{{
            t('fanfiction.openBook')
          }}</RouterLink>
        </article>
        <Button v-if="activityCursor" variant="outline" :disabled="busy" @click="moreActivity">{{ t('fanfiction.nextPage') }}</Button>
        <h2 class="text-lg font-medium">{{ t('fanfiction.operations') }}</h2>
        <p v-if="!jobs.length" class="text-muted-foreground text-sm">{{ t('fanfiction.noActivity') }}</p>
        <article
          v-for="job in jobs"
          :key="job.id"
          class="border-border bg-card flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
        >
          <div class="min-w-0 flex-1">
            <p class="break-words text-sm">{{ job.url }}</p>
            <p class="text-muted-foreground text-sm">{{ t(`fanfiction.kinds.${job.kind}`) }} · {{ dateLabel(job.updatedAt) }}</p>
            <ImportProgress :job="job" class="mt-3" />
            <RouterLink
              v-if="job.result?.bookId"
              :to="{ name: 'book-detail', params: { bookId: job.result.bookId } }"
              class="text-primary text-sm underline"
              >{{ t('fanfiction.openBook') }}</RouterLink
            >
          </div>
          <Button v-if="job.kind === 'source_batch'" variant="outline" :disabled="busy || bulk.busy" @click="reviewBatch(job)">{{
            t('fanfiction.bulk.review')
          }}</Button>
          <Button
            v-if="job.state === 'queued' || job.state === 'running'"
            variant="outline"
            :disabled="busy || job.cancellationRequested"
            @click="cancelJob(job)"
            >{{ t('fanfiction.cancel') }}</Button
          >
          <Button
            v-else-if="job.errorCode !== 'profile_deleted' && ['failed', 'cancelled', 'configuration_blocked', 'review_required'].includes(job.state)"
            variant="outline"
            :disabled="busy"
            @click="retryJob(job)"
            >{{ t('fanfiction.retry') }}</Button
          >
        </article>
        <Button v-if="jobCursor" variant="outline" :disabled="busy" @click="moreJobs">{{ t('fanfiction.nextPage') }}</Button>
      </section>
    </template>
  </main>
</template>

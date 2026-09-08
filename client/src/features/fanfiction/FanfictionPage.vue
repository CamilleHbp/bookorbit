<script setup lang="ts">
import ImportProgress from './components/ImportProgress.vue'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { BookOpen, Plus, Settings, RefreshCw } from '@lucide/vue'
import { Input } from '@/components/ui/input'
import FanfictionStoryRow from './components/FanfictionStoryRow.vue'
import FanfictionPagination from './components/FanfictionPagination.vue'
import { useFanfictionNavigation } from './composables/useFanfictionNavigation'
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
import { useFanfictionPreferences } from './composables/useFanfictionPreferences'
import { useFanfiction } from './composables/useFanfiction'

const { t } = useI18n()
const { hasPermission } = usePermissions()
const canManage = computed(() => hasPermission(Permission.ManageLibraries))
const page = useFanfiction()
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
  importStories,
  retryImport,
  useSavedProfile,
  cancelJob,
  retryJob,
  togglePaused,
  checkNow,
  refreshChapters,
  previousSources,
  previousJobs,
  previousActivity,
  sourceJobs,
  sourceErrors,
  checkingSourceId,
} = page
const { destination, showStories, showAdd, applyFilters, clearFilters, filtered } = useFanfictionNavigation(page)
const sourcePagination = reactive(page.sourcePagination)
const jobPagination = reactive(page.jobPagination)
const activityPagination = reactive(page.activityPagination)
const navigation = computed(() => [
  { id: 'stories' as const, label: t('fanfiction.stories') },
  { id: 'discovery' as const, label: t('fanfiction.discovery.title') },
  { id: 'activity' as const, label: t('fanfiction.activity') },
  { id: 'profiles' as const, label: t('fanfiction.profiles') },
])
const { sourceSettings, detectedSite, selectedProfile, addSource, editSource } = useInlineSourceSettings(libraryId, profiles, profileId, urls)
const preferences = reactive(useFanfictionPreferences())
const configuring = ref<(typeof candidates.value)[number] | null>(null)
function handleAddSource() {
  configuring.value = null
  addSource()
}
async function configureImport(candidate: (typeof candidates.value)[number]) {
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
async function allowAdultImport(candidate: (typeof candidates.value)[number]) {
  if (await preferences.allowAdult()) await retryImport(candidate)
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
const bulk = reactive(useFanfictionSourceBatch(libraryId, sources, page.appliedSearch, page.appliedState, refresh))
function reviewBatch(job: FanfictionJob) {
  showStories()
  void bulk.open(job.id)
}
const selecting = ref(false)
const selectionLabel = computed(() =>
  selecting.value || bulk.selectedIds.length > 0 || bulk.allMatching ? t('common.cancel') : t('fanfiction.selectStories'),
)
const showBulk = computed(() => selecting.value || bulk.selectedIds.length > 0 || bulk.allMatching || bulk.active || Boolean(bulk.error))
function toggleSelection() {
  const selected = selecting.value || bulk.selectedIds.length > 0 || bulk.allMatching
  selecting.value = !selected
  if (selected) bulk.clearSelection()
}
function selectStory(id: string, selected: boolean) {
  bulk.selectedIds = selected ? [...bulk.selectedIds, id] : bulk.selectedIds.filter((item) => item !== id)
}
watch(libraryId, () => {
  selecting.value = false
})
watch(
  () => bulk.active,
  (active) => {
    if (active) selecting.value = true
  },
)
function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString() : t('fanfiction.never')
}
onMounted(() => {
  if (canManage.value) void loadLibraries()
})
</script>

<template>
  <main v-if="canManage" class="mx-auto w-full max-w-7xl space-y-5 p-4 sm:p-6">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <BookOpen class="size-5 text-primary" aria-hidden="true" />
        <h1 class="text-lg font-semibold">{{ t('fanfiction.title') }}</h1>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="ghost" class="size-11" as-child
          ><RouterLink :to="{ name: 'settings-fanfiction' }" :aria-label="t('fanfiction.settingsTitle')"><Settings aria-hidden="true" /></RouterLink
        ></Button>
        <Button :disabled="libraryId === null" @click="showAdd"><Plus aria-hidden="true" />{{ t('fanfiction.addStories') }}</Button>
      </div>
    </header>
    <div class="flex flex-wrap items-end gap-2">
      <label class="min-w-0 flex-1 space-y-1 text-sm sm:max-w-xs"
        >{{ t('fanfiction.library') }}
        <select
          v-model="libraryId"
          :disabled="busy"
          class="border-input bg-background block h-11 w-full rounded-md border px-3 focus-visible:outline-2 focus-visible:outline-ring sm:h-9"
          @change="changeLibrary"
        >
          <option v-for="library in libraries" :key="library.id" :value="library.id">{{ library.name }}</option>
        </select>
      </label>
      <Button v-if="libraryCursor !== null" variant="outline" :disabled="busy" @click="loadLibraries">{{ t('fanfiction.moreLibraries') }}</Button>
      <Button
        variant="ghost"
        class="size-11 sm:size-9"
        :aria-label="t('fanfiction.refresh')"
        :disabled="busy || sourceSettings.busy || libraryId === null"
        @click="handleRefresh"
        ><RefreshCw class="size-4" :class="{ 'motion-safe:animate-spin': busy }" aria-hidden="true"
      /></Button>
    </div>
    <p v-if="!libraries.length && !busy" class="text-muted-foreground">{{ t('fanfiction.noLibraries') }}</p>
    <p v-if="error" role="alert" class="border-destructive text-destructive rounded-md border p-3 text-sm">{{ error }}</p>
    <template v-if="libraryId !== null">
      <nav class="flex overflow-x-auto border-b border-border scrollbar-none" :aria-label="t('fanfiction.title')">
        <RouterLink
          v-for="item in navigation"
          :key="item.id"
          :to="destination(item.id)"
          :aria-current="tab === item.id ? 'page' : undefined"
          class="shrink-0 border-b-2 px-2 py-3 text-sm font-medium sm:px-3 focus-visible:outline-2 focus-visible:outline-ring"
          :class="tab === item.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
          >{{ item.label }}</RouterLink
        >
      </nav>
      <div v-if="tab === 'profiles'" class="space-y-4">
        <p v-if="sourceSettings.error" role="alert" class="text-sm text-destructive">{{ sourceSettings.error }}</p>
        <SourceProfiles :settings="sourceSettings" @saved="useSavedProfile" @deleted="handleProfileDeleted" />
      </div>
      <section v-else-if="tab === 'stories'" class="space-y-4" :aria-label="t('fanfiction.stories')" :aria-busy="busy">
        <form class="flex flex-wrap items-center gap-2" @submit.prevent="applyFilters">
          <Input
            v-model="search"
            :disabled="busy"
            :aria-label="t('fanfiction.search')"
            :placeholder="t('fanfiction.search')"
            maxlength="200"
            class="h-11 min-w-40 flex-1 sm:h-9"
          />
          <select
            v-model="state"
            :disabled="busy"
            :aria-label="t('fanfiction.status')"
            class="border-input bg-background h-11 max-w-full rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring sm:h-9"
            @change="applyFilters"
          >
            <option value="">{{ t('fanfiction.allStates') }}</option>
            <option value="active">{{ t('fanfiction.sourceStates.active') }}</option>
            <option value="paused">{{ t('fanfiction.sourceStates.paused') }}</option>
            <option value="review_required">{{ t('fanfiction.states.review_required') }}</option>
            <option value="configuration_blocked">{{ t('fanfiction.states.configuration_blocked') }}</option>
          </select>
          <Button type="submit" variant="outline" :disabled="busy">{{ t('fanfiction.search') }}</Button>
          <Button v-if="sources.length" variant="ghost" :aria-pressed="showBulk" :disabled="busy || bulk.active" @click="toggleSelection">{{
            selectionLabel
          }}</Button>
        </form>
        <StoryBulkActions
          v-if="showBulk"
          v-model:all-matching="bulk.allMatching"
          v-model:action="bulk.action"
          v-model:interval="bulk.interval"
          :bulk="bulk"
          :loading="busy"
        />
        <p v-if="busy && !sources.length" role="status" class="py-12 text-center text-sm text-muted-foreground">{{ t('common.loading') }}</p>
        <div v-else-if="!sources.length" class="space-y-3 py-12 text-center">
          <p class="text-sm text-muted-foreground">{{ filtered ? t('fanfiction.noStories') : t('fanfiction.emptyStories') }}</p>
          <Button v-if="filtered" variant="outline" @click="clearFilters">{{ t('fanfiction.clearFilters') }}</Button>
          <Button v-else @click="showAdd"><Plus aria-hidden="true" />{{ t('fanfiction.addStories') }}</Button>
        </div>
        <div v-else>
          <FanfictionStoryRow
            v-for="source in sources"
            :key="source.id"
            :source="source"
            :job="sourceJobs[source.id]"
            :error="sourceErrors[source.id]"
            :pending="checkingSourceId === source.id"
            :disabled="busy || bulk.active"
            :selected="bulk.selectedIds.includes(source.id) || bulk.allMatching"
            :selection-disabled="busy || bulk.busy || bulk.active || bulk.allMatching"
            @select="selectStory(source.id, $event)"
            @check="checkNow(source)"
            @refresh="refreshChapters(source)"
            @pause="togglePaused(source)"
          />
        </div>
        <FanfictionPagination
          :page="sourcePagination.number"
          :previous="sourcePagination.canPrevious"
          :next="Boolean(sourceCursor)"
          :busy="busy"
          :label="t('fanfiction.stories')"
          @previous="previousSources"
          @next="moreSources"
        />
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
        <SourceProfileEditor :settings="sourceSettings" compact @saved="handleProfileSaved" />
        <p v-if="preferences.error" role="alert" class="text-sm text-destructive">{{ preferences.error }}</p>
        <Button :disabled="busy || sourceSettings.busy || sourceSettings.showEditor || !urls.trim() || folderId === null" @click="importStories">{{
          t('fanfiction.importStories')
        }}</Button>
        <article v-for="candidate in candidates" :key="candidate.previewKey" class="border-border bg-card space-y-2 rounded-lg border p-4">
          <p class="min-w-0 break-words font-medium">{{ candidate.preview?.title || candidate.url }}</p>
          <p v-if="candidate.preview" class="text-muted-foreground text-sm">
            {{ candidate.preview.authors.join(', ') }} · {{ t('fanfiction.chapterCount', { count: candidate.preview.chapterCount }) }} ·
            {{ candidate.preview.status }}
            <span v-if="candidate.preview.wordCount != null"> · {{ t('fanfiction.wordCount', { count: candidate.preview.wordCount }) }}</span>
          </p>
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
              v-if="candidate.job.errorCode === 'adult_confirmation_required'"
              :disabled="busy || preferences.busy"
              @click="allowAdultImport(candidate)"
              >{{ t('fanfiction.allowAdultStories') }}</Button
            >
            <Button
              v-else-if="['authentication_required', 'configuration_blocked', 'access_denied'].includes(candidate.job.errorCode ?? '')"
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
      <section v-else-if="tab === 'activity'" class="space-y-3" :aria-label="t('fanfiction.activity')">
        <h2 class="text-lg font-medium">{{ t('fanfiction.recentChanges') }}</h2>
        <article v-for="event in activity" :key="event.id" class="border-border bg-card rounded-lg border p-4">
          <p class="font-medium">{{ event.title }}</p>
          <p class="text-muted-foreground text-sm">{{ t(`fanfiction.activityKinds.${event.kind}`) }} · {{ dateLabel(event.createdAt) }}</p>
          <RouterLink v-if="event.bookId" :to="{ name: 'book-detail', params: { bookId: event.bookId } }" class="text-primary text-sm underline">{{
            t('fanfiction.openBook')
          }}</RouterLink>
        </article>
        <FanfictionPagination
          :page="activityPagination.number"
          :previous="activityPagination.canPrevious"
          :next="Boolean(activityCursor)"
          :busy="busy"
          :label="t('fanfiction.recentChanges')"
          @previous="previousActivity"
          @next="moreActivity"
        />
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
        <FanfictionPagination
          :page="jobPagination.number"
          :previous="jobPagination.canPrevious"
          :next="Boolean(jobCursor)"
          :busy="busy"
          :label="t('fanfiction.operations')"
          @previous="previousJobs"
          @next="moreJobs"
        />
      </section>
    </template>
  </main>
</template>

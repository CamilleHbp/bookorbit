<script setup lang="ts">
import WebsiteConnections from './components/WebsiteConnections.vue'
import StoryAttentionList from './components/StoryAttentionList.vue'
import { api } from '@/lib/api'
import { useCollections } from '@/features/collection/composables/useCollections'
import StoryReadingActions from './components/StoryReadingActions.vue'
import StoryFilters from './components/StoryFilters.vue'
import StorySchedule from './components/StorySchedule.vue'
import ImportProgress from './components/ImportProgress.vue'
import StoryImportReview from './components/StoryImportReview.vue'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { BookOpen, Plus, Settings, RefreshCw, Search } from '@lucide/vue'
import { Input } from '@/components/ui/input'
import FanfictionStoryRow from './components/FanfictionStoryRow.vue'
import FanfictionPagination from './components/FanfictionPagination.vue'
import { useFanfictionNavigation } from './composables/useFanfictionNavigation'
import { useI18n } from 'vue-i18n'
import { Permission, type FanfictionJob, type FanfictionSource, type FanfictionConnection } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import StoryBulkActions from './components/StoryBulkActions.vue'
import { useFanfictionBatchScope } from './composables/useFanfictionBatchScope'
import { useFanfictionSourceBatch } from './composables/useFanfictionSourceBatch'
import ExistingStories from './components/ExistingStories.vue'
import { useFanfictionPreferences } from './composables/useFanfictionPreferences'
import { useFanfiction } from './composables/useFanfiction'

const { t } = useI18n()
const { collections, fetchCollections } = useCollections()
const writableCollections = computed(() => collections.value.filter((collection) => collection.isOwner))
const { hasPermission } = usePermissions()
const canManage = computed(() => hasPermission(Permission.ManageLibraries))
const router = useRouter()
const requestedLibraryId = Number(router.currentRoute.value.query.libraryId)
const reviewSource = () =>
  typeof router.currentRoute.value.query.sourceId === 'string' && /^[0-9a-f-]{36}$/i.test(router.currentRoute.value.query.sourceId)
    ? router.currentRoute.value.query.sourceId
    : undefined
const page = useFanfiction(
  (bookId) => router.push({ name: 'book-detail', params: { bookId }, query: { tab: 'story-updates' } }),
  reviewSource,
  Number.isSafeInteger(requestedLibraryId) && requestedLibraryId > 0 ? requestedLibraryId : undefined,
)
watch(
  () => router.currentRoute.value.query.sourceId,
  () => {
    if (page.libraryId.value) void refresh()
  },
)
const {
  libraries,
  libraryCursor,
  libraryId,
  folders,
  folderCursor,
  folderId,
  sources,
  sourceCursor,
  jobs,
  jobCursor,
  activity,
  activityCursor,
  moreActivity,
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
  refresh: refreshStories,
  moreSources,
  moreJobs,
  importStories,
  importBatchStarted,
  importBatchPending,
  importBatchFinished,
  importBatchTotal,
  importBatchCompleted,
  importBatchNeedsAttention,
  startAnotherImportBatch,
  existingCandidate,
  existingStoryPosition,
  existingStoryCount,
  hasPreviousExistingStory,
  hasNextExistingStory,
  previousExistingStory,
  nextExistingStory,
  visibleCandidates,
  cancelExistingStory,
  updateExistingStory,
  retryImport,
  acceptImportReview,
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
const connectionIssues = ref<InstanceType<typeof WebsiteConnections> | null>(null)
const storyIssues = ref<InstanceType<typeof StoryAttentionList> | null>(null)
async function refresh() {
  await Promise.all([refreshStories(), connectionIssues.value?.reload?.(), storyIssues.value?.refresh?.()])
}
const existingNeedsReview = computed(() => existingCandidate.value?.existingStory?.attentionCode === 'metadata_review_required')
const importHeading = ref<HTMLElement | null>(null)
const urlInput = ref<HTMLTextAreaElement | null>(null)
const importBatchTitle = computed(() => {
  if (importBatchFinished.value) return t(importBatchNeedsAttention.value ? 'fanfiction.importBatch.attention' : 'fanfiction.importBatch.finished')
  return t('fanfiction.importBatch.title')
})
watch(importBatchStarted, async (started) => {
  if (started) {
    await nextTick()
    importHeading.value?.focus()
  }
})
async function handleAnotherBatch() {
  startAnotherImportBatch()
  await nextTick()
  urlInput.value?.focus()
}
const { destination, showStories, showAdd, applyFilters, clearFilters, filtered } = useFanfictionNavigation(page)
const sourcePagination = reactive(page.sourcePagination)
const jobPagination = reactive(page.jobPagination)
const activityPagination = reactive(page.activityPagination)
const navigation = computed(() => [
  { id: 'stories' as const, label: t('fanfiction.stories') },
  { id: 'activity' as const, label: t('fanfiction.activity') },
])
const preferences = reactive(useFanfictionPreferences())
const configuring = ref<(typeof page.candidates.value)[number] | null>(null)
async function configureImport(candidate: (typeof page.candidates.value)[number]) {
  configuring.value = candidate
  loginSource.value = undefined
  loginSite.value = new URL(candidate.url).hostname.replace(/^www\./, '')
}
const loginSite = ref('')
const loginSource = ref<FanfictionSource>()
const keepUpdated = computed({
  get: () => schedule.value !== 'manual',
  set: (value: boolean) => {
    schedule.value = value ? '1440' : 'manual'
  },
})
function closeLogin() {
  loginSite.value = ''
  loginSource.value = undefined
  configuring.value = null
}
async function handleConnectionSaved(_connection: FanfictionConnection, job?: FanfictionJob) {
  if (configuring.value) await retryImport(configuring.value)
  if (job) await bulk.open(job.id)
  closeLogin()
  await refresh()
}
async function allowAdultImport(candidate: (typeof page.candidates.value)[number]) {
  if (await preferences.allowAdult()) await retryImport(candidate)
}
function handleRefresh() {
  void batchScope.reload()
  void refresh()
}
watch(libraryId, () => {
  configuring.value = null
})
const batchScope = reactive(useFanfictionBatchScope(libraryId, page.appliedSearch, page.appliedState))
const libraryName = computed(() => libraries.value.find((library) => library.id === libraryId.value)?.name ?? '')
const bulk = reactive(
  useFanfictionSourceBatch(libraryId, sources, page.appliedSearch, page.appliedState, async () => {
    await Promise.all([refresh(), batchScope.reload()])
  }),
)
const sourceRepair = ref<HTMLElement | null>(null)
async function fixSourceLogin(id: string) {
  configuring.value = null
  let story = sources.value.find((item) => item.id === id)
  if (!story && libraryId.value) {
    const response = await api(`/api/v1/libraries/${libraryId.value}/fanfiction/sources/${id}`)
    if (!response.ok) {
      error.value = t('fanfiction.connections.loadFailed')
      return
    }
    story = (await response.json()) as FanfictionSource
  }
  if (!story) return
  loginSource.value = story
  loginSite.value = story.site
  await nextTick()
  sourceRepair.value?.focus()
}
function reviewBatch(job: FanfictionJob) {
  showStories()
  void bulk.open(job.id)
}
const advancedSelection = computed(() =>
  Boolean(page.appliedSearch.value || Object.entries(page.appliedFilters.value).some(([key, value]) => value && key !== 'sort')),
)
watch(
  () => [page.appliedSearch.value, ...Object.values(page.appliedFilters.value)],
  () => {
    bulk.clearSelection()
  },
)
const selecting = ref(false)
const selectionLabel = computed(() =>
  selecting.value || bulk.selectedIds.length > 0 || bulk.allMatching ? t('common.cancel') : t('fanfiction.selectStories'),
)
const showBulk = computed(() => selecting.value || bulk.selectedIds.length > 0 || bulk.allMatching || Boolean(bulk.job) || Boolean(bulk.error))
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
    if (active) {
      selecting.value = false
      bulk.clearSelection()
    }
  },
)
function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString() : t('fanfiction.never')
}
onMounted(() => {
  if (canManage.value) {
    void loadLibraries()
    void fetchCollections()
  }
})
</script>

<template>
  <main v-if="canManage" class="mx-auto w-full max-w-7xl space-y-4 p-4 sm:p-6">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <BookOpen class="size-5 text-primary" aria-hidden="true" />
        <h1 class="text-lg font-semibold">{{ t('fanfiction.title') }}</h1>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="ghost" class="size-11" as-child
          ><RouterLink :to="{ name: 'settings-website-logins' }" :aria-label="t('fanfiction.connections.title')"
            ><Settings aria-hidden="true" /></RouterLink
        ></Button>
        <Button v-if="tab !== 'add'" variant="outline" :disabled="libraryId === null" @click="showAdd"
          ><Plus aria-hidden="true" />{{ t('fanfiction.addStories') }}</Button
        >
      </div>
    </header>
    <div class="flex flex-wrap items-end gap-2">
      <label class="w-full min-w-0 flex-none space-y-1 text-sm sm:w-auto sm:flex-1 sm:max-w-xs"
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
      <div v-if="tab === 'stories'" class="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:ms-auto sm:flex-none">
        <span v-if="batchScope.counts" class="text-sm text-muted-foreground tabular-nums">{{
          t('fanfiction.bulk.storyCount', { count: batchScope.counts.total })
        }}</span>
        <Button
          :disabled="busy || bulk.busy || bulk.active || !(batchScope.counts?.eligible ?? batchScope.counts?.total)"
          :aria-label="t('fanfiction.bulk.checkLibrary', { library: libraryName })"
          @click="bulk.checkAll"
        >
          <RefreshCw class="size-4" aria-hidden="true" />{{ t('fanfiction.bulk.checkAll') }}
        </Button>
        <Button v-if="batchScope.error" variant="ghost" @click="batchScope.reload">{{ t('fanfiction.bulk.retryCount') }}</Button>
      </div>
      <Button v-if="libraryCursor !== null" variant="outline" :disabled="busy" @click="loadLibraries">{{ t('fanfiction.moreLibraries') }}</Button>
      <Button
        variant="ghost"
        class="size-11 sm:size-9"
        :aria-label="t('fanfiction.bulk.reload')"
        :disabled="busy || libraryId === null"
        @click="handleRefresh"
        ><RefreshCw class="size-4" :class="{ 'motion-safe:animate-spin': busy }" aria-hidden="true"
      /></Button>
    </div>
    <p v-if="!libraries.length && !busy" class="text-muted-foreground">{{ t('fanfiction.noLibraries') }}</p>
    <p v-if="error" role="alert" class="border-destructive text-destructive rounded-md border p-3 text-sm">{{ error }}</p>
    <template v-if="libraryId !== null">
      <div v-if="loginSite" ref="sourceRepair" tabindex="-1" class="focus:outline-none">
        <WebsiteConnections
          :library-id="libraryId"
          :focus-site="loginSite"
          :source="loginSource"
          repairs-only
          @saved="handleConnectionSaved"
          @cancel="closeLogin"
        />
      </div>
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
      <nav
        v-if="tab === 'add' || tab === 'discovery'"
        class="flex gap-4 border-b border-border py-3 text-sm"
        :aria-label="t('fanfiction.addStories')"
      >
        <RouterLink :to="destination('add')" :aria-current="tab === 'add' ? 'page' : undefined" class="text-primary underline">{{
          t('fanfiction.maintenance.fromWeb')
        }}</RouterLink>
        <RouterLink :to="destination('discovery')" :aria-current="tab === 'discovery' ? 'page' : undefined" class="text-primary underline">{{
          t('fanfiction.maintenance.fromLibrary')
        }}</RouterLink>
      </nav>
      <section v-if="tab === 'stories'" class="space-y-3 rounded-xl bg-card p-3 sm:p-4" :aria-label="t('fanfiction.stories')" :aria-busy="busy">
        <form class="flex flex-wrap items-center gap-2" @submit.prevent="applyFilters">
          <Input
            v-model="search"
            :disabled="busy"
            :aria-label="t('fanfiction.search')"
            :placeholder="t('fanfiction.search')"
            maxlength="200"
            class="h-11 min-w-40 flex-1 sm:h-9"
          />
          <Button type="submit" variant="outline" class="size-11 shrink-0 sm:size-9" :disabled="busy" :aria-label="t('fanfiction.search')"
            ><Search class="size-4" aria-hidden="true"
          /></Button>
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
          <Button v-if="sources.length" variant="ghost" :aria-pressed="selecting" :disabled="busy || bulk.active" @click="toggleSelection">{{
            selectionLabel
          }}</Button>
          <StoryFilters v-model="page.filters.value" :disabled="busy || bulk.active" />
        </form>
        <StoryBulkActions
          v-if="showBulk"
          v-model:all-matching="bulk.allMatching"
          v-model:action="bulk.action"
          v-model:interval="bulk.interval"
          :bulk="bulk"
          :loading="busy"
          :selecting="selecting || bulk.selectedIds.length > 0 || bulk.allMatching"
          :library-name="libraryName"
          :matching-count="batchScope.counts?.matching"
          :allow-all-matching="!advancedSelection"
          @fix-login="fixSourceLogin"
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
            @fix-login="fixSourceLogin"
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
        <header v-if="importBatchStarted" class="space-y-3 rounded-lg border border-border bg-card p-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 ref="importHeading" tabindex="-1" class="text-lg font-medium focus:outline-none">{{ importBatchTitle }}</h2>
            <Button v-if="importBatchFinished" @click="handleAnotherBatch">
              <Plus aria-hidden="true" />{{ t('fanfiction.importBatch.another') }}
            </Button>
          </div>
          <p role="status" class="text-sm text-muted-foreground">
            {{ t('fanfiction.importBatch.progress', { completed: importBatchCompleted, total: importBatchTotal }) }}
          </p>
          <progress class="block h-2 w-full accent-primary" :value="importBatchCompleted" :max="importBatchTotal" :aria-label="importBatchTitle" />
          <Button v-if="importBatchPending && !busy" variant="outline" @click="importStories">{{ t('fanfiction.importBatch.resume') }}</Button>
        </header>
        <form v-else class="space-y-4" @submit.prevent="importStories">
          <h2 class="text-lg font-medium">{{ t('fanfiction.addStories') }}</h2>
          <label class="block space-y-1 text-sm"
            >{{ t('fanfiction.storyUrls')
            }}<textarea
              ref="urlInput"
              v-model="urls"
              :disabled="busy"
              rows="5"
              maxlength="65536"
              class="border-input bg-background block w-full rounded-md border p-3"
              :placeholder="t('fanfiction.urlsHelp')"
            />
          </label>

          <label class="flex min-h-11 items-center gap-3 text-sm"
            ><input v-model="keepUpdated" type="checkbox" class="size-4 accent-primary" :disabled="busy" />{{
              t('fanfiction.maintenance.keepUpdated')
            }}</label
          >
          <StorySchedule v-if="keepUpdated" v-model="schedule" :disabled="busy" />
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
                >{{ t('fanfiction.importCollection') }}
                <select
                  v-model="page.collectionId.value"
                  :disabled="busy"
                  class="border-input bg-background block min-h-11 w-full rounded-md border p-2"
                >
                  <option :value="null">{{ t('fanfiction.noCollection') }}</option>
                  <option v-for="collection in writableCollections" :key="collection.id" :value="collection.id">{{ collection.name }}</option>
                </select>
              </label>
            </div>
            <div class="flex flex-wrap gap-2">
              <Button type="button" v-if="folderCursor !== null" variant="outline" :disabled="busy" @click="moreFolders">{{
                t('fanfiction.moreFolders')
              }}</Button>
            </div>
          </details>
          <Button type="submit" :disabled="busy || !urls.trim() || folderId === null">{{ t('fanfiction.importStories') }}</Button>
        </form>
        <p v-if="preferences.error" role="alert" class="text-sm text-destructive">{{ preferences.error }}</p>
        <section v-if="existingCandidate" class="border-border rounded-lg border p-4 space-y-3">
          <p class="font-medium">{{ existingCandidate.existingStory?.title }}</p>
          <Button :disabled="busy || !canManage" @click="updateExistingStory">{{
            t(existingNeedsReview ? 'fanfiction.metadataReview.title' : 'fanfiction.updateStory')
          }}</Button>
          <Button variant="outline" :disabled="busy" @click="cancelExistingStory">{{ t('common.cancel') }}</Button>
          <div v-if="existingStoryCount > 1" class="mt-4 space-y-2">
            <p class="text-muted-foreground text-sm" aria-live="polite">
              {{ t('fanfiction.existingStoryPosition', { current: existingStoryPosition + 1, total: existingStoryCount }) }}
            </p>
            <div class="flex gap-2">
              <Button variant="outline" :disabled="busy || !hasPreviousExistingStory" @click="previousExistingStory">
                {{ t('common.previous') }}
              </Button>
              <Button variant="outline" :disabled="busy || !hasNextExistingStory" @click="nextExistingStory">
                {{ t('common.next') }}
              </Button>
            </div>
          </div>
          <p v-if="error" role="alert" class="text-destructive mt-2 text-sm">{{ error }}</p>
        </section>
        <article v-for="candidate in visibleCandidates" :key="candidate.previewKey" class="border-border bg-card space-y-2 rounded-lg border p-4">
          <p class="min-w-0 break-words font-medium">{{ candidate.preview?.title || candidate.url }}</p>
          <p v-if="candidate.preview" class="text-muted-foreground text-sm">
            {{ candidate.preview.authors.join(', ') }} · {{ t('fanfiction.chapterCount', { count: candidate.preview.chapterCount }) }} ·
            {{ candidate.preview.status }}
            <span v-if="candidate.preview.wordCount != null"> · {{ t('fanfiction.wordCount', { count: candidate.preview.wordCount }) }}</span>
          </p>
          <p v-if="candidate.preview" class="break-all text-sm text-muted-foreground">{{ candidate.url }}</p>
          <StoryImportReview
            v-if="candidate.job?.state === 'review_required' && candidate.job.result?.importReview"
            :job="candidate.job"
            :disabled="!canManage"
            @updated="acceptImportReview"
          />
          <ImportProgress v-else-if="candidate.job" :job="candidate.job" />
          <p v-else role="status" class="text-sm text-muted-foreground">{{ t('fanfiction.importBatch.pending') }}</p>
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
              :disabled="busy"
              @click="configureImport(candidate)"
              >{{ t('fanfiction.configureSource') }}</Button
            >
            <Button v-else :disabled="busy" @click="retryImport(candidate)">{{ t('fanfiction.retry') }}</Button>
          </template>
          <StoryReadingActions
            v-if="candidate.job?.result?.bookId && candidate.job.result.bookFileId"
            :book-id="candidate.job.result.bookId"
            :book-file-id="candidate.job.result.bookFileId"
          />
          <RouterLink
            v-if="candidate.job?.result?.bookId"
            :to="{ name: 'book-detail', params: { bookId: candidate.job.result.bookId } }"
            class="text-primary text-sm underline"
            >{{ t('fanfiction.openBook') }}</RouterLink
          >
        </article>
        <div v-if="importBatchFinished && visibleCandidates.length > 3" class="flex justify-end">
          <Button @click="handleAnotherBatch"><Plus aria-hidden="true" />{{ t('fanfiction.importBatch.another') }}</Button>
        </div>
      </section>
      <ExistingStories v-else-if="tab === 'discovery'" :key="libraryId" :library-id="libraryId" />
      <section v-else-if="tab === 'activity'" class="space-y-3" :aria-label="t('fanfiction.activity')">
        <StoryBulkActions
          v-if="bulk.job"
          v-model:all-matching="bulk.allMatching"
          v-model:action="bulk.action"
          v-model:interval="bulk.interval"
          :bulk="bulk"
          :loading="busy"
          :selecting="false"
          :library-name="libraryName"
          @fix-login="fixSourceLogin"
        />
        <WebsiteConnections ref="connectionIssues" :library-id="libraryId" repairs-only @saved="handleConnectionSaved" />
        <StoryAttentionList ref="storyIssues" :library-id="libraryId" />
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
        <details :open="Boolean(reviewSource())" class="space-y-3 border-t border-border pt-3">
          <summary class="min-h-11 cursor-pointer py-3 font-medium">{{ t('fanfiction.operations') }}</summary>
          <RouterLink v-if="reviewSource()" :to="{ name: 'fanfiction', query: { tab: 'activity' } }" class="text-primary underline">{{
            t('fanfiction.metadataReview.allActivity')
          }}</RouterLink>
          <p v-if="!jobs.length" class="text-muted-foreground text-sm">{{ t('fanfiction.noActivity') }}</p>
          <article
            v-for="job in jobs"
            :key="job.id"
            class="border-border bg-card flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
          >
            <div class="min-w-0 flex-1">
              <p class="break-words text-sm">{{ job.url }}</p>
              <p class="text-muted-foreground text-sm">{{ t(`fanfiction.kinds.${job.kind}`) }} · {{ dateLabel(job.updatedAt) }}</p>
              <StoryImportReview
                v-if="job.state === 'review_required' && job.result?.importReview"
                :job="job"
                :disabled="!canManage"
                @updated="acceptImportReview"
              />
              <ImportProgress v-else :job="job" class="mt-3" />
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
              v-else-if="
                !job.result?.contentReview &&
                !job.result?.metadataReview &&
                !job.result?.importReview &&
                ['failed', 'cancelled', 'configuration_blocked', 'review_required'].includes(job.state)
              "
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
        </details>
      </section>
    </template>
  </main>
</template>

<script setup lang="ts">
import ChapterDifferences from './ChapterDifferences.vue'
import { canRetryWebsiteAccess, chapterDecision } from '../composables/downloadIssue'
import type { BookFileRevisionSummary } from '@bookorbit/types'
import WebsiteConnections from './WebsiteConnections.vue'
import StoryUpdateOutcome from './StoryUpdateOutcome.vue'
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import StorySchedule from './StorySchedule.vue'
import StoryMetadataReview from './StoryMetadataReview.vue'
import type { useBookStory } from '../composables/useBookStory'

const props = defineProps<{ state: ReturnType<typeof useBookStory>; reviewMode?: boolean }>()
const router = useRouter()
const emit = defineEmits<{ reviewed: []; skip: [] }>()
const metadataEditor = ref<InstanceType<typeof StoryMetadataReview>>()
function skipReview() {
  emit('skip')
}
function commitPending() {
  return metadataEditor.value?.commitPending() !== false
}
function handleMetadataSave() {
  void saveReview()
}
async function saveReview() {
  if (props.state.busy.value || !props.state.metadataReview.value) return
  const libraryId = props.state.source.value?.libraryId
  await props.state.resolveMetadata()
  if (props.state.error.value || props.state.metadataReview.value) return
  if (props.reviewMode) emit('reviewed')
  else if (libraryId) await router.push({ name: 'fanfiction', query: { tab: 'review', review: 'attention', libraryId } })
}
defineExpose({ commitPending })
const { t } = useI18n()
const {
  updatePolicy,
  keepUpdated,
  approveContent,
  discardContent,
  allowed,
  metadataReview,
  metadataChoices,
  deferMetadata,
  discardMetadata,
  reviewDeferred,
  resumeMetadataReview,
  visible,
  loading,
  error,
  sources,
  sourceId,
  source,
  canUpdate,
  canReplace,
  canApproveReplacement,
  replacementFile,
  chooseReplacement,
  uploadReplacement,
  approveReplacement,
  sourceCursor,
  tagPolicy,
  interval,
  revisions,
  revisionCursor,
  currentRevisionId,
  job,
  busy,
  refresh,
  selectSource,
  updateSettings,
  ignoreMissingWarning,
  pause,
  unlink,
  checkNow,
  refreshChapters,
  retryJob,
  rollback,
  olderRevisions,
  moreSources,
} = props.state
const decision = computed(() => chapterDecision(job.value?.result?.changes))
const connecting = ref(false)
function showLogin() {
  connecting.value = true
}
function closeLogin() {
  connecting.value = false
}
async function loginSaved() {
  connecting.value = false
  await refresh()
}
const restore = ref<BookFileRevisionSummary | null>(null)
function requestRestore(revision: BookFileRevisionSummary) {
  restore.value = revision
}
function cancelRestore() {
  restore.value = null
}
async function confirmRestore() {
  if (restore.value) await rollback(restore.value)
  restore.value = null
}
const updating = computed(() => busy.value || (job.value !== null && ['queued', 'running'].includes(job.value.state)))
function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString() : t('fanfiction.never')
}
onMounted(() => {
  if (!loading.value) void refresh()
})
</script>

<template>
  <section v-if="visible" class="mx-auto max-w-4xl space-y-5">
    <header v-if="!reviewMode" class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-xl font-semibold">{{ t('fanfiction.storyUpdates') }}</h1>
      <Button variant="outline" :disabled="busy || loading" @click="refresh">{{ t('fanfiction.refresh') }}</Button>
    </header>
    <p v-if="error" role="alert" class="text-destructive text-sm">{{ error }}</p>
    <Button v-if="reviewMode && error" variant="outline" :disabled="busy || loading" @click="refresh">{{ t('fanfiction.retry') }}</Button>
    <p v-if="loading" role="status" class="text-muted-foreground">{{ t('common.loading') }}</p>
    <div v-if="allowed && !loading && !sources.length" class="space-y-3">
      <p class="text-muted-foreground">{{ t('fanfiction.noManagedSource') }}</p>
      <RouterLink :to="{ name: 'fanfiction' }" class="text-primary underline">{{ t('fanfiction.title') }}</RouterLink>
    </div>
    <template v-if="allowed && source">
      <Button v-if="metadataReview && reviewDeferred" @click="resumeMetadataReview">{{ t('fanfiction.metadataReview.title') }}</Button>
      <StoryMetadataReview
        v-else-if="metadataReview"
        ref="metadataEditor"
        v-model="metadataChoices"
        :review="metadataReview.review"
        :save-label="t('fanfiction.reviewQueue.save')"
        :busy="busy"
        @save="handleMetadataSave"
        @later="deferMetadata"
        @discard="discardMetadata"
      >
        <template v-if="reviewMode" #actions="{ save: submitReview }">
          <slot name="review-actions" :save="submitReview"
            ><div class="sticky bottom-0 z-10 flex flex-wrap gap-2 border-t border-border bg-card py-3">
              <Button type="button" class="min-h-11" variant="outline" :disabled="busy" @click="skipReview">{{
                t('fanfiction.reviewQueue.skip')
              }}</Button>
              <Button type="button" class="min-h-11 w-full sm:w-auto" :disabled="busy" @click="submitReview">{{
                t('fanfiction.reviewQueue.save')
              }}</Button>
            </div></slot
          >
        </template>
      </StoryMetadataReview>
      <select
        v-if="!reviewMode && sources.length > 1"
        v-model="sourceId"
        :aria-label="t('fanfiction.stories')"
        class="border-input bg-background w-full rounded-md border p-2"
        @change="selectSource"
      >
        <option v-for="item in sources" :key="item.id" :value="item.id">{{ item.title }}</option>
      </select>
      <div
        v-if="(!reviewMode || !metadataReview) && (!reviewMode || !job?.result?.contentReview)"
        class="border-border bg-card space-y-3 rounded-xl border p-4"
      >
        <a :href="source.canonicalUrl" target="_blank" rel="noopener noreferrer" class="text-primary break-words underline">{{
          source.canonicalUrl
        }}</a>
        <p>
          {{ source.storyStatus }} · {{ t('fanfiction.chapterCount', { count: source.chapterCount }) }} ·
          {{ t((source.tracking?.enabled ?? source.state !== 'paused') ? 'fanfiction.maintenance.enabled' : 'fanfiction.maintenance.paused') }}
          <span v-if="source.wordCount !== null"> · {{ t('fanfiction.wordCount', { count: source.wordCount }) }}</span>
        </p>
        <p v-if="source.attentionCode" class="text-destructive text-sm">{{ t(`fanfiction.errors.${source.attentionCode}`) }}</p>
        <Button
          v-if="source.attentionCode === 'source_not_found' && canUpdate && source.bookFileId && !source.metadataReviewPending"
          variant="outline"
          :disabled="updating"
          @click="ignoreMissingWarning"
          >{{ t('fanfiction.ignoreMissingWarning') }}</Button
        >
        <details v-if="canReplace" :open="source.attentionCode === 'fanfiction_net_browser_verification'" class="space-y-4">
          <summary class="cursor-pointer font-medium">{{ t('fanfiction.connections.updateSavedBook') }}</summary>
          <p v-if="source.site === 'fanfiction.net'" class="text-sm">
            <a href="/bookorbit-story-updates.zip" download class="text-primary underline">{{ t('fanfiction.browserExtension') }}</a>
          </p>
          <form class="space-y-3" @submit.prevent="uploadReplacement">
            <h2 class="font-semibold">{{ t('fanfiction.replacementTitle') }}</h2>
            <p class="text-muted-foreground text-sm">{{ t('fanfiction.replacementHelp') }}</p>
            <label class="block space-y-2 text-sm">
              {{ t('fanfiction.replacementFile') }}
              <input
                type="file"
                :data-bookorbit-story="source?.canonicalUrl"
                accept=".epub,application/epub+zip"
                :disabled="updating"
                class="block w-full"
                @change="chooseReplacement"
              />
            </label>
            <p v-if="replacementFile" class="text-sm break-words">{{ replacementFile.name }}</p>
            <Button type="submit" :disabled="updating || !replacementFile">{{ t('fanfiction.replacementUpload') }}</Button>
          </form>
        </details>
        <dl v-if="!reviewMode" class="text-muted-foreground grid gap-2 text-sm sm:grid-cols-2">
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
          <Button v-if="canUpdate || canRetryWebsiteAccess(source)" :disabled="updating" @click="checkNow">{{ t('fanfiction.checkNow') }}</Button>
          <Button v-if="canUpdate" variant="outline" :disabled="updating" @click="refreshChapters">{{ t('fanfiction.refreshChapters') }}</Button>
          <Button v-if="canUpdate && !reviewMode" variant="outline" :disabled="busy" @click="pause">{{
            !(source.tracking?.enabled ?? source.state !== 'paused') ? t('fanfiction.resumeUpdates') : t('fanfiction.pauseUpdates')
          }}</Button>
          <Button v-if="!reviewMode" variant="outline" :disabled="updating" @click="unlink">{{ t('fanfiction.unlink') }}</Button>
        </div>
        <p v-if="!reviewMode" class="text-muted-foreground text-xs">{{ t('fanfiction.unlinkHelp') }}</p>
      </div>
      <Button
        v-if="!reviewMode && ['authentication_required', 'access_denied'].includes(source.attentionCode ?? '')"
        variant="outline"
        @click="showLogin"
        >{{ t('fanfiction.bulk.fixLogin') }}</Button
      >
      <WebsiteConnections
        v-if="connecting && !reviewMode"
        :library-id="source.libraryId"
        :source="source"
        :focus-site="source.site"
        repairs-only
        @saved="loginSaved"
        @cancel="closeLogin"
      />
      <form v-if="!reviewMode" class="border-border space-y-4 rounded-xl border p-4" @submit.prevent="updateSettings">
        <label class="flex min-h-11 items-center gap-3 text-sm"
          ><input v-model="keepUpdated" type="checkbox" :disabled="updating" class="size-4 accent-primary" />{{
            t('fanfiction.maintenance.keepUpdated')
          }}</label
        >
        <StorySchedule v-if="keepUpdated" v-model="interval" :disabled="updating" />
        <label class="block space-y-1 text-sm"
          >{{ t('fanfiction.maintenance.policy') }}
          <select v-model="updatePolicy" :disabled="updating" class="border-input bg-background block min-h-11 w-full rounded-md border p-2">
            <option value="safe">{{ t('fanfiction.maintenance.safe') }}</option>
            <option value="review">{{ t('fanfiction.maintenance.review') }}</option>
          </select>
        </label>
        <p class="max-w-prose text-sm text-muted-foreground">{{ t('fanfiction.maintenance.safeHelp') }}</p>
        <details class="space-y-3">
          <summary class="min-h-11 cursor-pointer py-3 text-sm font-medium">{{ t('fanfiction.advanced') }}</summary>
          <Button type="button" variant="outline" :disabled="updating" @click="showLogin">{{ t('fanfiction.maintenance.useMine') }}</Button>

          <label class="block space-y-1 text-sm"
            >{{ t('fanfiction.tagPolicy')
            }}<select v-model="tagPolicy" :disabled="updating" class="border-input bg-background block min-h-11 w-full rounded-md border p-2">
              <option value="review">{{ t('fanfiction.tagPolicyReview') }}</option>
              <option value="automatic">{{ t('fanfiction.tagPolicyAutomatic') }}</option>
            </select></label
          >
          <p class="text-sm text-muted-foreground">{{ t('fanfiction.tagPolicyHelp') }}</p>
        </details>
        <div class="flex flex-wrap items-center gap-3">
          <Button type="submit" :disabled="updating">{{ t('common.save') }}</Button>
          <Button variant="outline" as-child
            ><RouterLink :to="{ name: 'settings-website-logins' }">{{ t('fanfiction.settingsTitle') }}</RouterLink></Button
          >
        </div>
      </form>
      <div v-if="job && (!reviewMode || !metadataReview)" role="status" class="border-border rounded-xl border p-4 text-sm">
        {{ t(`fanfiction.kinds.${job.kind}`) }} · {{ t(`fanfiction.states.${job.state}`) }}
        <StoryUpdateOutcome :job="job" />
        <p v-if="job.errorCode && !job.result?.contentReview" class="text-destructive">{{ t(`fanfiction.errors.${job.errorCode}`) }}</p>
        <Button v-if="!reviewMode && ['review_required', 'source_chapter_reduction'].includes(job.errorCode ?? '')" variant="outline" as-child>
          <RouterLink :to="{ name: 'settings-website-logins' }">{{ t('fanfiction.maintenance.defaultPolicy') }}</RouterLink>
        </Button>
        <div v-if="job.result?.contentReview && !job.result.contentReview.approved" class="space-y-3 py-3">
          <p class="font-semibold">{{ t(`fanfiction.downloads.${decision.key}`, { count: decision.count }) }}</p>
          <ChapterDifferences :changes="job.result?.changes" />
          <p>{{ t('fanfiction.downloads.keepHint') }}</p>
          <div class="flex flex-wrap gap-2">
            <Button :disabled="updating || job.result?.changes?.incompletePreview || job.result?.changes?.differentStory" @click="approveContent">{{
              t('fanfiction.downloads.useWebsite')
            }}</Button
            ><Button variant="outline" :disabled="updating" @click="discardContent">{{ t('fanfiction.maintenance.keepCopy') }}</Button>
          </div>
        </div>
        <div v-if="job.result?.replacement" class="my-3 space-y-2">
          <p>{{ job.result.replacement.title }}</p>
          <p>
            {{
              t('fanfiction.replacementChapters', {
                previous: job.result.replacement.previousChapterCount,
                next: job.result.replacement.chapterCount,
              })
            }}
          </p>
          <Button v-if="canApproveReplacement" :disabled="updating" @click="approveReplacement">{{ t('fanfiction.replacementApprove') }}</Button>
        </div>
        <Button
          v-if="
            !job.result?.contentReview &&
            !metadataReview &&
            !canApproveReplacement &&
            ['failed', 'cancelled', 'configuration_blocked', 'review_required'].includes(job.state)
          "
          variant="outline"
          :disabled="updating"
          @click="retryJob"
          >{{ t('fanfiction.retry') }}</Button
        >
      </div>
      <details v-if="!reviewMode" class="space-y-4">
        <summary class="cursor-pointer font-medium">{{ t('book.detail.files.revisions.title') }}</summary>
        <section class="border-border space-y-3 rounded-xl border p-4">
          <h2 class="font-semibold">{{ t('book.detail.files.revisions.title') }}</h2>
          <p class="text-muted-foreground text-sm">{{ t('fanfiction.rollbackHelp') }}</p>
          <div v-if="restore" class="space-y-3 rounded-lg border border-border p-3" role="alert">
            <p>{{ t('fanfiction.restoreConfirm', { date: dateLabel(restore.createdAt) }) }}</p>
            <p v-if="restore.chapterCount">{{ t('fanfiction.chapterCount', { count: restore.chapterCount }) }}</p>
            <div class="flex flex-wrap gap-2">
              <Button :disabled="updating" @click="confirmRestore">{{ t('fanfiction.rollback') }}</Button
              ><Button variant="outline" :disabled="updating" @click="cancelRestore">{{ t('common.cancel') }}</Button>
            </div>
          </div>
          <article
            v-for="revision in revisions"
            :key="revision.revision"
            class="border-border flex flex-wrap items-center justify-between gap-3 border-t pt-3"
          >
            <div class="text-sm">
              <p>
                {{ t(`book.detail.files.revisions.${revision.changeKind}`)
                }}<span v-if="revision.reason === 'rollback'"> · {{ t('fanfiction.kinds.rollback') }}</span
                ><span v-if="revision.reason === 'replacement'"> · {{ t('fanfiction.kinds.replacement') }}</span
                ><span v-if="revision.revision === currentRevisionId"> · {{ t('fanfiction.currentRevision') }}</span>
              </p>
              <p class="text-muted-foreground">
                {{ dateLabel(revision.createdAt)
                }}<span v-if="revision.chapterCount"> · {{ t('fanfiction.chapterCount', { count: revision.chapterCount }) }}</span>
              </p>
            </div>
            <Button v-if="revision.canRollback" variant="outline" :disabled="updating || !!metadataReview" @click="requestRestore(revision)">{{
              t('fanfiction.rollback')
            }}</Button>
          </article>
          <Button v-if="revisionCursor" variant="outline" :disabled="busy" @click="olderRevisions">{{
            t('book.detail.files.revisions.older')
          }}</Button>
        </section>
      </details>
    </template>
    <Button v-if="sourceCursor" variant="outline" :disabled="busy" @click="moreSources">{{ t('fanfiction.nextPage') }}</Button>
  </section>
</template>

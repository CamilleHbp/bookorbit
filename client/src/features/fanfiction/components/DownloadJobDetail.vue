<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft } from '@lucide/vue'
import type { FanfictionDownloadRow, FanfictionJob } from '@bookorbit/types'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import StoryImportReview from './StoryImportReview.vue'
import ImportProgress from './ImportProgress.vue'
import { needsImportReview } from '../composables/useImportReview'
import { chapterDecision } from '../composables/downloadIssue'
const props = defineProps<{ libraryId: number; row: FanfictionDownloadRow; checkedAt?: Date }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const job = ref<FanfictionJob>()
const busy = ref(false),
  error = ref(false)
const heading = ref<HTMLElement>()
const editor = ref<InstanceType<typeof StoryImportReview>>()
const url = `/api/v1/libraries/${props.libraryId}/fanfiction/jobs/${props.row.jobId}`
const lifetime = new AbortController()
onScopeDispose(() => lifetime.abort())
const decision = computed(() => chapterDecision(job.value?.result?.changes ?? props.row))
const content = computed(() => job.value?.state === 'review_required' && job.value.result?.contentReview?.approved === false)
const retryable = computed(() => {
  const j = job.value
  return (
    !!j &&
    ['failed', 'cancelled', 'configuration_blocked', 'review_required'].includes(j.state) &&
    !needsImportReview(j) &&
    !content.value &&
    !(j.result?.metadataReview?.beforeUpdate && !j.result.preparedUpdate?.approved)
  )
})
const restartable = computed(
  () =>
    !!job.value?.result?.importReview?.approved &&
    ['failed', 'cancelled'].includes(job.value.state) &&
    ['metadata', 'downloading', 'packaging', 'validating'].includes(job.value.result.progress?.stage ?? 'metadata'),
)
const bookId = computed(() => job.value?.result?.bookId ?? props.row.bookId)
watch(
  () => props.checkedAt,
  () => {
    if (!busy.value && job.value && ['queued', 'running'].includes(job.value.state)) void load()
  },
)
async function load() {
  busy.value = true
  error.value = false
  try {
    const response = await api(url, { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(20000)]) })
    if (!response.ok) throw new Error()
    job.value = await response.json()
  } catch {
    error.value = true
  } finally {
    busy.value = false
  }
}
function canLeave() {
  return editor.value?.canLeave() ?? true
}
function close() {
  if (canLeave()) emit('close')
}
function updated() {
  emit('close')
}
async function act(action: 'apply' | 'discard' | 'retry' | 'cancel' | 'restart') {
  if (busy.value) return
  if (action === 'restart' && !window.confirm(t('fanfiction.importInbox.confirmRestart', { title: props.row.title }))) return
  busy.value = true
  error.value = false
  const decision = action === 'apply' || action === 'discard'
  try {
    const response = await api(url + '/' + (decision ? 'content-review' : action === 'restart' ? 'retry' : action), {
      method: 'POST',
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(20000)]),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(decision ? { action } : action === 'restart' ? { restart: true } : {}),
    })
    if (!response.ok) throw new Error()
    if (!lifetime.signal.aborted) updated()
  } catch {
    error.value = true
  } finally {
    busy.value = false
  }
}
const apply = () => act('apply'),
  discard = () => act('discard'),
  retry = () => act('retry'),
  cancel = () => act('cancel'),
  restart = () => act('restart')
onMounted(async () => {
  await nextTick()
  heading.value?.focus()
  await load()
})
defineExpose({ canLeave })
</script>
<template>
  <section class="space-y-4">
    <Button variant="ghost" @click="close"><ArrowLeft aria-hidden="true" />{{ t('fanfiction.importInbox.back') }}</Button>
    <div>
      <p class="text-sm text-muted-foreground">{{ row.site }}</p>
      <h2 ref="heading" tabindex="-1" class="font-serif text-3xl break-words">{{ row.title }}</h2>
    </div>
    <p v-if="error" role="alert" class="text-destructive">
      {{ t('fanfiction.downloads.actionError') }} <button class="underline" :disabled="busy" @click="load">{{ t('fanfiction.refresh') }}</button>
    </p>
    <p v-if="busy && !job" role="status">{{ t('common.loading') }}</p>
    <template v-if="job">
      <StoryImportReview ref="editor" v-if="needsImportReview(job)" :job="job" @updated="updated" />
      <div v-else-if="content" class="space-y-3 border-s-2 border-primary bg-muted/50 p-4">
        <h3 class="font-semibold">{{ t('fanfiction.downloads.' + decision.key, { count: decision.count }) }}</h3>
        <p v-if="row.currentChapters !== null && row.proposedChapters !== null">
          {{ t('fanfiction.downloads.compare', { saved: row.currentChapters, website: row.proposedChapters }) }}
        </p>
        <p class="text-sm">{{ t('fanfiction.downloads.keepHint') }}</p>
        <div class="flex flex-wrap gap-2">
          <Button :disabled="busy" @click="discard">{{ t('fanfiction.maintenance.keepCopy') }}</Button
          ><Button variant="outline" :disabled="busy" @click="apply">{{ t('fanfiction.downloads.useWebsite') }}</Button>
        </div>
      </div>
      <ImportProgress v-else :job="job" />
      <div class="flex flex-wrap items-center gap-3">
        <RouterLink v-if="bookId" :to="{ name: 'book-detail', params: { bookId }, query: { tab: 'story-updates' } }" class="text-primary underline">{{
          t('fanfiction.storyUpdates')
        }}</RouterLink>
        <RouterLink v-if="row.issue === 'login'" :to="{ name: 'settings-website-logins' }" class="text-primary underline">{{
          t('fanfiction.tasks.websiteLogins')
        }}</RouterLink>
        <a :href="job.url" target="_blank" rel="noopener noreferrer" class="text-primary underline">{{ t('fanfiction.downloads.openSource') }}</a>
        <Button v-if="retryable" :disabled="busy" @click="retry">{{ t('fanfiction.importInbox.retry') }}</Button>
        <Button v-if="['running', 'queued'].includes(job.state)" variant="outline" :disabled="busy || job.cancellationRequested" @click="cancel">{{
          t('fanfiction.cancel')
        }}</Button>
        <Button v-if="restartable" variant="ghost" :disabled="busy" @click="restart">{{ t('fanfiction.importInbox.restart') }}</Button>
      </div>
    </template>
  </section>
</template>

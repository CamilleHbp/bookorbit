<script setup lang="ts">
import TagReviewNotice from './TagReviewNotice.vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { FanfictionJob } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { useImportReview } from '../composables/useImportReview'
import StoryMetadataFields from './StoryMetadataFields.vue'
import StoryCategories from './StoryCategories.vue'
const props = defineProps<{ job: FanfictionJob; disabled?: boolean }>()
const emit = defineEmits<{ updated: [job: FanfictionJob] }>()
const { t } = useI18n()
const { values, busy, error, deferred, apply, later, discard, resume } = useImportReview(
  () => props.job,
  (job) => {
    initial.value = JSON.stringify(values.value)
    emit('updated', job)
  },
)
const fields = ref<InstanceType<typeof StoryMetadataFields>>()
const initial = ref(JSON.stringify(values.value))
const dirty = computed(() => JSON.stringify(values.value) !== initial.value)
function canLeave() {
  if (busy.value || fields.value?.commitPending() === false) return false
  return !dirty.value || window.confirm(t('fanfiction.reviewQueue.discardDrafts'))
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (fields.value?.commitPending() === false || dirty.value || busy.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onBeforeRouteLeave(canLeave)
onBeforeRouteUpdate(canLeave)
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
defineExpose({ canLeave })
function handleDiscard() {
  if (window.confirm(t('fanfiction.importInbox.confirmDiscard', { title: values.value.title }))) void discard()
}
function handleApply() {
  if (fields.value?.commitPending()) void apply()
}
function handleLater() {
  if (fields.value?.commitPending()) void later()
}
</script>
<template>
  <Button v-if="deferred" @click="resume">{{ t('fanfiction.previewStory') }}</Button>
  <form v-else class="w-full space-y-5" @submit.prevent="handleApply">
    <TagReviewNotice :count="job.result?.importReview?.preview?.pendingLabelCount" />
    <StoryMetadataFields ref="fields" v-model="values" :disabled="busy || disabled" />
    <details v-if="job.result?.importReview?.preview?.categories" class="border-t border-border pt-3">
      <summary class="min-h-11 cursor-pointer py-2 text-sm text-muted-foreground">{{ t('fanfiction.importInbox.sourceDetails') }}</summary>
      <StoryCategories :categories="job.result.importReview.preview.categories" />
    </details>
    <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
    <div class="grid grid-cols-2 gap-2 border-t border-border bg-background py-3 sm:sticky sm:bottom-0 sm:flex sm:flex-wrap">
      <Button class="col-span-2 min-h-11" type="submit" :disabled="busy || disabled">{{ t('fanfiction.confirmImport') }}</Button>
      <Button class="min-h-11" type="button" variant="outline" :disabled="busy || disabled" @click="handleLater">{{
        t('fanfiction.importInbox.saveDraft')
      }}</Button>
      <Button class="min-h-11" type="button" variant="ghost" :disabled="busy || disabled" @click="handleDiscard">{{
        t('fanfiction.metadataReview.discardImport')
      }}</Button>
    </div>
  </form>
</template>

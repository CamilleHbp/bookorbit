<script setup lang="ts">
import { ref } from 'vue'
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
  (job) => emit('updated', job),
)
const fields = ref<InstanceType<typeof StoryMetadataFields>>()
function handleApply() {
  if (fields.value?.commitPending()) void apply()
}
</script>
<template>
  <Button v-if="deferred" @click="resume">{{ t('fanfiction.previewStory') }}</Button>
  <form v-else class="space-y-4 border-border rounded-lg border p-4 w-full" @submit.prevent="handleApply">
    <h3 class="font-semibold">{{ t('fanfiction.previewStory') }}</h3>
    <StoryCategories :categories="job.result?.importReview?.preview?.categories" />
    <StoryMetadataFields ref="fields" v-model="values" :disabled="busy || disabled" />
    <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
    <div class="flex flex-wrap gap-2">
      <Button type="submit" :disabled="busy || disabled">{{ t('fanfiction.confirmImport') }}</Button>
      <Button type="button" variant="outline" :disabled="busy || disabled" @click="later">{{ t('fanfiction.metadataReview.later') }}</Button>
      <Button type="button" variant="ghost" :disabled="busy || disabled" @click="discard">{{ t('fanfiction.metadataReview.discardImport') }}</Button>
    </div>
  </form>
</template>

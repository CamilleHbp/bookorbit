<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FanfictionJob } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

const props = defineProps<{ job: FanfictionJob }>()
const emit = defineEmits<{ resolved: [job: FanfictionJob] }>()
const { t } = useI18n()
const chapter = computed(() => props.job.result?.contentReview?.chapters?.find((item) => !item.decision))
const remaining = ref(false)
const busy = ref(false)
const failed = ref(false)
watch(
  () => chapter.value?.key,
  () => {
    remaining.value = false
    failed.value = false
  },
)
async function choose(choice: 'saved' | 'website') {
  if (busy.value || !chapter.value) return
  busy.value = true
  failed.value = false
  try {
    const response = await api(`/api/v1/libraries/${props.job.libraryId}/fanfiction/jobs/${props.job.id}/content-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'apply', chapterKey: chapter.value.key, choice, remaining: remaining.value }),
    })
    if (!response.ok) throw new Error()
    emit('resolved', await response.json())
  } catch {
    failed.value = true
  } finally {
    busy.value = false
  }
}
const keep = () => choose('saved')
const replace = () => choose('website')
</script>
<template>
  <section v-if="chapter" class="space-y-3" aria-live="polite">
    <h3 class="font-semibold">{{ chapter.title }}</h3>
    <p>{{ t('fanfiction.downloads.chapterLengths', { saved: chapter.savedLength, website: chapter.websiteLength }) }}</p>
    <dl v-if="chapter.savedExcerpt || chapter.websiteExcerpt" class="grid gap-3 sm:grid-cols-2">
      <div>
        <dt class="font-medium">{{ t('fanfiction.metadataReview.current') }}</dt>
        <dd class="break-words text-sm">{{ chapter.savedExcerpt }}</dd>
      </div>
      <div>
        <dt class="font-medium">{{ t('fanfiction.sourceReview.remoteBook') }}</dt>
        <dd class="break-words text-sm">{{ chapter.websiteExcerpt }}</dd>
      </div>
    </dl>
    <a :href="chapter.sourceUrl" target="_blank" rel="noopener noreferrer" class="text-primary underline">{{
      t('fanfiction.downloads.openSource')
    }}</a>
    <label class="flex min-h-11 items-center gap-2"
      ><input v-model="remaining" type="checkbox" :disabled="busy" />{{ t('fanfiction.downloads.remainingConflicts') }}</label
    >
    <div class="flex flex-wrap gap-2">
      <Button :disabled="busy" @click="keep">{{ t('fanfiction.downloads.keepChapter') }}</Button>
      <Button :disabled="busy" variant="outline" @click="replace">{{ t('fanfiction.downloads.useWebsite') }}</Button>
    </div>
    <p v-if="failed" role="alert" class="text-destructive">{{ t('fanfiction.downloads.actionError') }}</p>
  </section>
</template>

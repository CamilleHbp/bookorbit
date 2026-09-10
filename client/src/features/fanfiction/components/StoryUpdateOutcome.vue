<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { FanfictionJob } from '@bookorbit/types'
const props = defineProps<{ job: FanfictionJob }>()
const { t } = useI18n()
const result = computed(() => props.job.result)
const changes = computed(() => result.value?.changes)
const first = computed(() => changes.value?.added[0])
</script>
<template>
  <div v-if="changes" class="space-y-1 text-sm" role="status">
    <p v-if="changes.added.length">{{ t('fanfiction.outcome.added', { count: changes.added.length }) }}</p>
    <p v-if="changes.changed">{{ t('fanfiction.outcome.changed', { count: changes.changed }) }}</p>
    <p v-if="changes.metadataChanged">{{ t('fanfiction.outcome.metadata') }}</p>
    <RouterLink
      v-if="first && result?.bookId && result.bookFileId && job.state === 'succeeded'"
      :to="{ name: 'reader', params: { bookId: result.bookId, fileId: result.bookFileId }, query: { format: 'epub', chapter: first.href } }"
      class="text-primary underline"
      >{{ t('fanfiction.outcome.readNew') }}</RouterLink
    >
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { FanfictionReading } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import AddToCollectionSheet from '@/features/collection/components/AddToCollectionSheet.vue'
const props = defineProps<{ bookId: number; bookFileId: number; reading?: FanfictionReading }>()
const { t } = useI18n()
const collectionOpen = ref(false)
const reader = computed(() => ({ name: 'reader', params: { bookId: props.bookId, fileId: props.bookFileId }, query: { format: 'epub' } }))
const nextChapter = computed(() => ({ ...reader.value, query: { ...reader.value.query, chapter: props.reading?.nextChapterHref } }))
function openCollection() {
  collectionOpen.value = true
}
</script>
<template>
  <div class="space-y-2">
    <p v-if="reading" class="text-sm text-muted-foreground">
      {{ t(`fanfiction.reading.${reading.status}`) }}
      <span v-if="reading.readChapters !== null">
        · {{ t('fanfiction.reading.progress', { read: reading.readChapters, total: reading.totalChapters }) }}</span
      >
    </p>
    <div class="flex flex-wrap gap-2">
      <Button as-child
        ><RouterLink :to="reader">{{
          t(reading && reading.status !== 'unread' ? 'fanfiction.reading.continue' : 'fanfiction.reading.read')
        }}</RouterLink></Button
      >
      <Button v-if="reading?.nextChapterHref && reading.status !== 'unread'" variant="outline" as-child
        ><RouterLink :to="nextChapter">{{ t('fanfiction.reading.readUnread', { count: reading.unreadChapters }) }}</RouterLink></Button
      >
      <Button variant="ghost" @click="openCollection">{{ t('fanfiction.reading.collection') }}</Button>
    </div>
    <AddToCollectionSheet v-model:open="collectionOpen" :selection-payload="{ bookIds: [bookId] }" :selected-count="1" />
  </div>
</template>

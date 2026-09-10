<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FanfictionReaderStory } from '@bookorbit/types'
import { Permission } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import LinkStorySource from './LinkStorySource.vue'
import { api } from '@/lib/api'
import StoryCategories from './StoryCategories.vue'
import StoryReadingActions from './StoryReadingActions.vue'
import KoreaderCopiesPanel from '@/features/koreader/components/KoreaderCopiesPanel.vue'
const props = defineProps<{ bookId: number; bookFileId: number; libraryId: number }>()
const { t } = useI18n()
const { hasPermission } = usePermissions()
const loaded = ref(false)
const story = ref<FanfictionReaderStory | null>(null)
const error = ref(false)
const copiesOpen = ref(false)
function toggleCopies(event: Event) {
  copiesOpen.value = (event.target as HTMLDetailsElement).open
}
watch(
  () => [props.bookId, props.bookFileId],
  async (_, __, cleanup) => {
    const controller = new AbortController()
    cleanup(() => controller.abort())
    story.value = null
    error.value = false
    loaded.value = false
    try {
      const response = await api(`/api/v1/books/${props.bookId}/files/${props.bookFileId}/story`, { signal: controller.signal })
      if (!response.ok) throw new Error('Could not load story')
      story.value = await response.json()
      loaded.value = true
    } catch {
      if (!controller.signal.aborted) error.value = true
    }
  },
  { immediate: true },
)
</script>
<template>
  <section v-if="story" class="my-4 space-y-4 rounded-xl border border-border p-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-semibold">{{ t('fanfiction.reading.story') }}</h2>
      <a :href="story.canonicalUrl" target="_blank" rel="noopener noreferrer" class="text-sm text-primary underline">{{
        t('fanfiction.reading.source')
      }}</a>
    </div>
    <p class="text-sm text-muted-foreground">{{ story.storyStatus }} · {{ t('fanfiction.chapterCount', { count: story.chapterCount }) }}</p>
    <StoryReadingActions :book-id="bookId" :book-file-id="bookFileId" :reading="story.reading" />
    <StoryCategories :categories="story.categories ?? undefined" />
    <details class="space-y-3" @toggle="toggleCopies">
      <summary class="cursor-pointer text-sm font-medium">{{ t('koreaderCopies.title') }}</summary>
      <KoreaderCopiesPanel v-if="copiesOpen" :book-file-id="bookFileId" />
    </details>
  </section>
  <p v-else-if="error" role="status" class="my-4 text-sm text-muted-foreground">{{ t('fanfiction.reading.loadFailed') }}</p>
  <LinkStorySource
    v-else-if="loaded && hasPermission(Permission.ManageLibraries)"
    :book-id="bookId"
    :book-file-id="bookFileId"
    :library-id="libraryId"
  />
</template>

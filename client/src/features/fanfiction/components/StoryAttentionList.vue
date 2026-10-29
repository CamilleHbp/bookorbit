<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { FanfictionSource, FanfictionSourcePage } from '@bookorbit/types'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
const props = defineProps<{ libraryId: number }>()
const { t } = useI18n()
const stories = ref<FanfictionSource[]>([])
const cursor = ref<string | null>(null)
const busy = ref(false)
const error = ref(false)
let controller: AbortController | undefined
async function load(next?: string) {
  controller?.abort()
  const current = new AbortController()
  controller = current
  busy.value = true
  error.value = false
  const timeout = setTimeout(() => current.abort(), 20000)
  try {
    const query = new URLSearchParams({ view: 'attention', excludeSharedAccess: 'true', limit: '25', ...(next ? { cursor: next } : {}) })
    const response = await api(`/api/v1/libraries/${props.libraryId}/fanfiction/sources?${query}`, { signal: current.signal })
    if (!response.ok) throw new Error()
    const result = (await response.json()) as FanfictionSourcePage
    if (controller !== current || current.signal.aborted) return
    stories.value = result.items
    cursor.value = result.nextCursor
  } catch {
    if (controller === current) error.value = true
  } finally {
    clearTimeout(timeout)
    if (controller === current) busy.value = false
  }
}
const refresh = () => load()
const next = () => load(cursor.value ?? undefined)
defineExpose({ refresh })
watch(() => props.libraryId, refresh, { immediate: true })
onScopeDispose(() => {
  controller?.abort()
  controller = undefined
})
</script>
<template>
  <section class="space-y-3">
    <h2 class="text-lg font-semibold">{{ t('fanfiction.maintenance.attention') }}</h2>
    <p v-if="error" role="alert" class="text-sm text-destructive">{{ t('fanfiction.connections.loadFailed') }}</p>
    <Button v-if="error" variant="outline" :disabled="busy" @click="refresh">{{ t('fanfiction.retry') }}</Button>
    <p v-if="busy" role="status" class="text-sm text-muted-foreground">{{ t('common.loading') }}</p>
    <p v-else-if="!stories.length && !error" class="text-sm text-muted-foreground">{{ t('fanfiction.maintenance.noAttention') }}</p>
    <ul class="divide-y divide-border">
      <li v-for="story in stories" :key="story.id" class="flex flex-wrap items-center justify-between gap-3 py-4">
        <div class="min-w-0 flex-1 space-y-1">
          <p class="break-words font-medium">{{ story.title }}</p>
          <p class="text-sm text-muted-foreground">
            {{
              story.metadataReviewPending
                ? t('fanfiction.metadataReview.title')
                : story.attentionCode
                  ? t(`fanfiction.errors.${story.attentionCode}`)
                  : t('fanfiction.reviewStory')
            }}
          </p>
        </div>
        <Button variant="outline" as-child
          ><RouterLink
            :to="
              story.bookId
                ? { name: 'book-detail', params: { bookId: story.bookId }, query: { tab: 'story-updates' } }
                : { name: 'fanfiction', query: { tab: 'activity', libraryId, sourceId: story.id } }
            "
            >{{ t('fanfiction.reviewStory') }}</RouterLink
          ></Button
        >
      </li>
    </ul>
    <div class="flex flex-wrap gap-2">
      <Button v-if="cursor" variant="outline" :disabled="busy" @click="next">{{ t('fanfiction.nextPage') }}</Button
      ><Button v-if="stories.length" variant="ghost" :disabled="busy" @click="refresh">{{ t('fanfiction.refresh') }}</Button>
    </div>
  </section>
</template>

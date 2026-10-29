<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { BookRevisionChangeKind } from '@bookorbit/types'
import { formatBytes } from '@/lib/formatting'
import { formatDate } from '@/i18n/formatters'
import { useBookRevisions } from '../composables/useBookRevisions'

const props = defineProps<{ libraryId: number; fileId: number }>()
const { t } = useI18n()
const { expanded, loading, failed, items, nextCursor, currentCursor, toggle, older, newest, retry } = useBookRevisions(
  () => props.libraryId,
  () => props.fileId,
)
const labels: Record<BookRevisionChangeKind, string> = {
  baseline: 'book.detail.files.revisions.baseline',
  unknown: 'book.detail.files.revisions.unknown',
  content: 'book.detail.files.revisions.content',
  cover: 'book.detail.files.revisions.cover',
  metadata: 'book.detail.files.revisions.metadata',
  container: 'book.detail.files.revisions.container',
}
function revisionDate(value: string) {
  return formatDate(new Date(value))
}
</script>

<template>
  <section class="rounded-xl border border-border bg-card p-4">
    <button
      class="w-full text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :aria-expanded="expanded"
      @click="toggle"
    >
      {{ t('book.detail.files.revisions.title') }}
    </button>
    <div v-if="expanded" class="mt-3 space-y-3" :aria-busy="loading">
      <p v-if="loading" role="status" class="text-sm text-muted-foreground">{{ t('book.detail.files.revisions.loading') }}</p>
      <div v-else-if="failed" role="alert" class="space-y-2 text-sm">
        <p>{{ t('book.detail.files.revisions.error') }}</p>
        <button class="rounded border border-input px-3 py-1.5 hover:bg-muted" @click="retry">{{ t('common.retry') }}</button>
      </div>
      <template v-else>
        <p v-if="!items.length" class="text-sm text-muted-foreground">{{ t('book.detail.files.revisions.empty') }}</p>
        <ol class="space-y-3">
          <li v-for="revision in items" :key="revision.revision" class="border-b border-border pb-3 text-sm last:border-0 last:pb-0">
            <p class="font-medium">{{ t(labels[revision.changeKind] ?? labels.unknown) }}</p>
            <p class="text-muted-foreground">{{ revisionDate(revision.createdAt) }} · {{ formatBytes(revision.sizeBytes) }}</p>
          </li>
        </ol>
        <div v-if="currentCursor || nextCursor" class="flex flex-wrap gap-2">
          <button v-if="currentCursor" class="rounded border border-input px-3 py-1.5 text-sm hover:bg-muted" @click="newest">
            {{ t('book.detail.files.revisions.newest') }}
          </button>
          <button v-if="nextCursor" class="rounded border border-input px-3 py-1.5 text-sm hover:bg-muted" @click="older">
            {{ t('book.detail.files.revisions.older') }}
          </button>
        </div>
      </template>
    </div>
  </section>
</template>

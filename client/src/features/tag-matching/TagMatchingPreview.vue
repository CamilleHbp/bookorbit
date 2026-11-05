<script setup lang="ts">
import { onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, ChevronLeft, ChevronRight } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useTagMatchingJobs } from './composables/useTagMatchingJobs'
import TagMatchingBookDetails from './TagMatchingBookDetails.vue'
import type { MatchingRow } from './composables/useTagMatching'
const emit = defineEmits<{ close: []; review: [row: MatchingRow] }>()
function reviewLabel(row: MatchingRow) {
  emit('review', row)
}
const { t } = useI18n()
const preview = reactive(useTagMatchingJobs())
const changes = ['addedTags', 'removedTags', 'addedGenres', 'removedGenres'] as const
function close() {
  emit('close')
}
onMounted(preview.initialize)
</script>
<template>
  <section class="flex h-full min-h-0 flex-col gap-4" :aria-label="t('tagMatching.preview.title')">
    <header class="flex flex-wrap items-center gap-3">
      <Button variant="ghost" :aria-label="t('common.back')" @click="close"><ArrowLeft class="size-4" /></Button>
      <h1 class="text-lg font-semibold">{{ t('tagMatching.preview.title') }}</h1>
    </header>
    <fieldset class="flex flex-wrap gap-x-6 gap-y-2 text-sm" :disabled="preview.busy">
      <legend class="mb-2 font-medium">{{ t('tagMatching.preview.override') }}</legend>
      <label class="flex min-h-10 items-center gap-2"
        ><input v-model="preview.overrideTags" type="checkbox" class="size-4 accent-primary" />{{ t('tagMatching.fields.tags') }}</label
      >
      <label class="flex min-h-10 items-center gap-2"
        ><input v-model="preview.overrideGenres" type="checkbox" class="size-4 accent-primary" />{{ t('tagMatching.fields.genres') }}</label
      >
      <p class="basis-full text-muted-foreground">{{ t('tagMatching.preview.locksRemain') }}</p>
    </fieldset>
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="outline" :disabled="preview.busy" @click="preview.preview">{{ t('tagMatching.preview.generate') }}</Button>
      <Button :disabled="!preview.canApply" @click="preview.apply">{{ t('tagMatching.preview.apply') }}</Button>
      <Button v-if="preview.job?.state === 'failed' || preview.error" variant="outline" :disabled="preview.busy" @click="preview.resume">{{
        t('common.retry')
      }}</Button>
      <p v-if="preview.dirty && preview.job" class="text-sm text-muted-foreground">{{ t('tagMatching.preview.changedOptions') }}</p>
    </div>
    <p v-if="preview.error" role="alert" class="text-sm text-destructive">{{ preview.error }}</p>
    <div v-if="preview.job" role="status" aria-live="polite" class="space-y-1 text-sm">
      <p class="font-medium">
        {{ t(`tagMatching.preview.states.${preview.job.state}`) }} ·
        {{ t('tagMatching.preview.progress', { count: preview.job.processed, total: preview.total }) }}
      </p>
      <p>{{ t('tagMatching.preview.summary', { changed: preview.job.changed, skipped: preview.job.skipped }) }}</p>
      <p v-if="preview.job.state === 'ready' && !preview.job.changed" class="text-muted-foreground">{{ t('tagMatching.preview.noChanges') }}</p>
      <p v-if="preview.job.error" class="text-muted-foreground">{{ t('tagMatching.preview.failures') }}</p>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto" :aria-busy="preview.busy">
      <p v-if="!preview.job" class="py-8 text-sm text-muted-foreground">{{ t('tagMatching.preview.intro') }}</p>
      <p v-else-if="!preview.total && !preview.busy" class="py-8 text-sm text-muted-foreground">{{ t('tagMatching.preview.empty') }}</p>
      <ul v-else class="divide-y divide-border">
        <li v-for="(item, index) in preview.items" :key="item.change.bookId" class="space-y-2 py-4">
          <h2 class="break-words font-medium">{{ item.change.title || t('tagMatching.preview.book', { id: item.change.bookId }) }}</h2>
          <p v-if="item.state === 'skipped'" class="text-sm text-muted-foreground">{{ t('tagMatching.preview.skipped') }}</p>
          <p v-if="!changes.some((field) => item.change[field].length)" class="text-sm text-muted-foreground">
            {{ t('tagMatching.preview.bookUnchanged') }}
          </p>
          <dl class="grid gap-3 text-sm sm:grid-cols-2">
            <template v-for="field in changes" :key="field">
              <div v-if="item.change[field].length">
                <dt class="text-muted-foreground">{{ t(`tagMatching.preview.${field}`) }}</dt>
                <dd class="break-words">{{ item.change[field].join(', ') }}</dd>
              </div>
            </template>
          </dl>
          <p v-if="item.change.lockedFields.length" class="text-sm text-muted-foreground">
            {{ t('tagMatching.preview.locked') }}:
            <span v-for="(field, index) in item.change.lockedFields" :key="field">{{ index ? ', ' : '' }}{{ t(`tagMatching.fields.${field}`) }}</span>
          </p>
          <p v-if="item.change.unresolved" class="text-sm text-muted-foreground">
            {{ t('tagMatching.preview.unresolved', { count: item.change.unresolved }) }}
          </p>
          <TagMatchingBookDetails
            v-if="preview.job && !preview.busy"
            :key="`${preview.job.id}:${item.change.bookId}`"
            :job-id="preview.job.id"
            :initially-open="index === 0"
            :change="item.change"
            @review="reviewLabel"
          />
        </li>
      </ul>
    </div>
    <nav v-if="preview.pages > 1" class="flex items-center justify-between gap-3" :aria-label="t('tagMatching.preview.pages')">
      <Button variant="outline" :disabled="preview.busy || preview.page <= 1" :aria-label="t('common.previous')" @click="preview.previous"
        ><ChevronLeft class="size-4"
      /></Button>
      <span class="text-sm">{{ preview.page }} / {{ preview.pages }}</span>
      <Button variant="outline" :disabled="preview.busy || preview.page >= preview.pages" :aria-label="t('common.next')" @click="preview.next"
        ><ChevronRight class="size-4"
      /></Button>
    </nav>
  </section>
</template>

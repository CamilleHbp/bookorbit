<script setup lang="ts">
import { onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TagMatchingChange, TagMatchingPreviewLabel } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { useTagMatchingBookDetails } from './composables/useTagMatchingBookDetails'
import type { MatchingRow } from './composables/useTagMatching'
const props = defineProps<{ jobId: string; change: TagMatchingChange; initiallyOpen?: boolean }>()
const emit = defineEmits<{ review: [row: MatchingRow] }>()
const { t } = useI18n()
const details = reactive(useTagMatchingBookDetails(props.jobId, props.change.bookId))
onMounted(() => {
  if (props.initiallyOpen) void details.toggle()
})
const fields = ['addedTags', 'removedTags', 'addedGenres', 'removedGenres'] as const
function review(label: TagMatchingPreviewLabel) {
  emit('review', {
    source: label.source,
    field: label.field,
    value: label.status === 'missing-fandom' ? props.change.title : label.value,
    bookCount: 1,
    ...(label.status === 'missing-fandom' ? { bookId: props.change.bookId, sourceKey: label.sourceKey } : {}),
  })
}
</script>
<template>
  <div class="space-y-3">
    <Button variant="outline" :aria-expanded="details.open" @click="details.toggle">{{
      t(details.open ? 'tagMatching.preview.hideDetails' : 'tagMatching.preview.showDetails')
    }}</Button>
    <div v-if="details.open" class="space-y-4" :aria-busy="details.busy">
      <p v-if="details.error" role="alert" class="text-sm text-destructive">{{ details.error }}</p>
      <Button v-if="details.error" variant="outline" :disabled="details.busy" @click="details.load">{{ t('common.retry') }}</Button>
      <p v-if="details.busy" role="status" class="text-sm text-muted-foreground">{{ t('common.loading') }}</p>
      <template v-if="details.data">
        <div v-if="details.hasProtectedChanges" class="space-y-2 text-sm">
          <h3 class="font-medium">{{ t('tagMatching.preview.protectedChanges') }}</h3>
          <dl class="grid gap-3 sm:grid-cols-2">
            <template v-for="field in fields" :key="field"
              ><div v-if="details.data.protectedChanges[field].length">
                <dt class="text-muted-foreground">{{ t(`tagMatching.preview.${field}`) }}</dt>
                <dd class="break-words">{{ details.data.protectedChanges[field].join(', ') }}</dd>
              </div></template
            >
          </dl>
        </div>
        <h3 class="text-sm font-medium">{{ t('tagMatching.preview.incomingLabels') }}</h3>
        <ul class="divide-y divide-border">
          <li
            v-for="(label, index) in details.data.labels"
            :key="index"
            class="grid gap-2 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          >
            <div class="min-w-0 space-y-1">
              <p class="break-words font-medium">{{ label.status === 'missing-fandom' ? t('tagMatching.preview.missingFandom') : label.value }}</p>
              <p class="break-words text-muted-foreground">{{ label.source }} · {{ t(`tagMatching.fields.${label.field}`) }}</p>
            </div>
            <div class="min-w-0 space-y-1">
              <p>{{ t(`tagMatching.preview.labelStates.${label.status}`) }}</p>
              <ul v-if="label.targets.length">
                <li v-for="target in label.targets" :key="`${target.field}:${target.id}`" class="break-words">
                  {{ target.name }} ({{ t(`tagMatching.fields.${target.field}`) }})<span v-if="target.excluded">
                    · {{ t('tagMatching.preview.excluded') }}</span
                  >
                </li>
              </ul>
            </div>
            <Button v-if="label.status === 'pending' || label.status === 'missing-fandom'" variant="outline" @click="review(label)">{{
              t('tagMatching.preview.reviewLabel')
            }}</Button>
          </li>
        </ul>
        <nav v-if="details.pages > 1" class="flex items-center justify-between gap-2" :aria-label="t('tagMatching.preview.labelPages')">
          <Button variant="outline" :disabled="details.busy || details.page === 1" @click="details.previous">{{ t('common.previous') }}</Button>
          <span class="text-sm">{{ details.page }} / {{ details.pages }}</span>
          <Button variant="outline" :disabled="details.busy || details.page === details.pages" @click="details.next">{{ t('common.next') }}</Button>
        </nav>
      </template>
    </div>
  </div>
</template>

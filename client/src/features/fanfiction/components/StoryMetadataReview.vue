<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { FanfictionMetadataReview, FanfictionMetadataResolution } from '@bookorbit/types'
import { Button } from '@/components/ui/button'

defineProps<{ review: FanfictionMetadataReview; busy: boolean }>()
const choices = defineModel<Pick<FanfictionMetadataResolution, 'title' | 'description' | 'authors' | 'tags'>>({ required: true })
const emit = defineEmits<{ save: [] }>()
const { t } = useI18n()
function display(value: string | string[]) {
  return Array.isArray(value) ? value.join(', ') : value
}
function handleSave() {
  emit('save')
}
</script>

<template>
  <form class="border-primary bg-card space-y-4 rounded-xl border p-4" @submit.prevent="handleSave">
    <h2 class="text-lg font-semibold">{{ t('fanfiction.metadataReview.title') }}</h2>
    <p class="text-muted-foreground text-sm">{{ t('fanfiction.metadataReview.help') }}</p>
    <fieldset v-for="field in review.fields" :key="field" class="border-border space-y-3 border-t pt-3">
      <legend class="font-medium">{{ t(`fanfiction.metadataReview.fields.${field}`) }}</legend>
      <div class="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <p class="text-muted-foreground">{{ t('fanfiction.metadataReview.current') }}</p>
          <p class="max-h-48 overflow-auto whitespace-pre-wrap break-words">
            {{ display(review.current[field]) || t('fanfiction.metadataReview.empty') }}
          </p>
        </div>
        <div>
          <p class="text-muted-foreground">{{ t('fanfiction.metadataReview.incoming') }}</p>
          <p class="max-h-48 overflow-auto whitespace-pre-wrap break-words">
            {{ display(review.incoming[field]) || t('fanfiction.metadataReview.empty') }}
          </p>
        </div>
      </div>
      <select
        v-model="choices[field]"
        :disabled="busy || review.lockedFields.includes(field)"
        :aria-label="t(`fanfiction.metadataReview.fields.${field}`)"
        class="border-input bg-background w-full rounded-md border p-2 text-sm"
      >
        <option value="keep">{{ t('fanfiction.metadataReview.keep') }}</option>
        <option v-if="field === 'tags'" value="merge">{{ t('fanfiction.metadataReview.merge') }}</option>
        <option v-else value="incoming">{{ t('fanfiction.metadataReview.useIncoming') }}</option>
      </select>
      <p v-if="review.lockedFields.includes(field)" class="text-muted-foreground text-sm">{{ t('fanfiction.metadataReview.locked') }}</p>
    </fieldset>
    <Button type="submit" :disabled="busy">{{ t('common.save') }}</Button>
  </form>
</template>

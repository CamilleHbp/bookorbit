<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import type { FanfictionMetadataReview, FanfictionMetadataChoices } from '@bookorbit/types'
import { Button } from '@/components/ui/button'

const props = defineProps<{ review: FanfictionMetadataReview; busy: boolean }>()
const choices = defineModel<FanfictionMetadataChoices>({ required: true })
const emit = defineEmits<{ save: []; later: []; discard: [] }>()
const tagOptions = computed(() => [...new Set([...(props.review.tags?.managed ?? []), ...props.review.incoming.tags])].sort())
const finalTags = computed(() =>
  [
    ...new Set([
      ...(props.review.tags?.custom ?? []),
      ...(choices.value.tags === 'keep'
        ? (props.review.tags?.managed ?? props.review.current.tags)
        : choices.value.tags === 'select'
          ? (choices.value.selectedTags ?? [])
          : tagOptions.value),
    ]),
  ].sort(),
)
const handleLater = () => emit('later')
const handleDiscard = () => emit('discard')
function toggleTag(tag: string) {
  const selected = new Set(choices.value.selectedTags ?? props.review.incoming.tags)
  if (selected.has(tag)) selected.delete(tag)
  else selected.add(tag)
  choices.value = { ...choices.value, tags: 'select', selectedTags: [...selected] }
}
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
    <p class="text-muted-foreground text-sm">
      {{ t(review.beforeUpdate ? 'fanfiction.metadataReview.beforeHelp' : 'fanfiction.metadataReview.help') }}
    </p>
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
      <template v-if="field === 'tags' && review.tags">
        <p class="text-sm">
          {{ t('fanfiction.metadataReview.customTags') }}: {{ review.tags.custom.join(', ') || t('fanfiction.metadataReview.empty') }}
        </p>
        <div class="max-h-64 overflow-auto space-y-2">
          <label v-for="tag in tagOptions" :key="tag" class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              :checked="(choices.selectedTags ?? review.incoming.tags).includes(tag)"
              :disabled="busy || review.lockedFields.includes('tags')"
              @change="toggleTag(tag)"
            />
            <span>{{ tag }}</span
            ><span class="text-muted-foreground" v-if="review.tags.added.includes(tag)">{{ t('fanfiction.metadataReview.added') }}</span
            ><span class="text-muted-foreground" v-else-if="review.tags.removed.includes(tag)">{{ t('fanfiction.metadataReview.removed') }}</span>
          </label>
        </div>
        <p class="text-sm">
          <strong>{{ t('fanfiction.metadataReview.result') }}</strong
          >: {{ finalTags.join(', ') || t('fanfiction.metadataReview.empty') }}
        </p>
      </template>
      <select
        v-else
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
    <div class="flex flex-wrap gap-2">
      <Button type="submit" :disabled="busy">{{ t(review.beforeUpdate ? 'fanfiction.metadataReview.apply' : 'common.save') }}</Button>
      <Button v-if="review.beforeUpdate" type="button" variant="outline" :disabled="busy" @click="handleLater">{{
        t('fanfiction.metadataReview.later')
      }}</Button>
      <Button v-if="review.beforeUpdate" type="button" variant="ghost" :disabled="busy" @click="handleDiscard">{{
        t('fanfiction.metadataReview.discard')
      }}</Button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { nextTick, ref, toRef, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { LockKeyhole } from '@lucide/vue'
import type { FanfictionMetadataReview, FanfictionMetadataChoices, FanfictionMetadataField } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ChipInput from '@/components/ui/ChipInput.vue'
import RichDescriptionEditor from '@/features/book/components/detail/tabs/RichDescriptionEditor.vue'
import { useGenreSearch, useTagSearch } from '@/features/book/composables/useTagSearch'
import { useStoryMetadataReview } from '../composables/useStoryMetadataReview'
import StoryMetadataReference from './StoryMetadataReference.vue'

const props = defineProps<{ review: FanfictionMetadataReview; busy: boolean }>()
const choices = defineModel<FanfictionMetadataChoices>({ required: true })
const emit = defineEmits<{ save: []; later: []; discard: [] }>()
const { t } = useI18n()
const id = useId()
const { search: searchTags } = useTagSearch()
const { search: searchGenres } = useGenreSearch()
const inputs = ref<InstanceType<typeof ChipInput>[]>([])
const form = ref<HTMLFormElement>()
const fields: FanfictionMetadataField[] = ['title', 'authors', 'description', 'genres', 'tags']
const { finalValues, inputVersions, updateField, chooseSource, combine } = useStoryMetadataReview(toRef(props, 'review'), choices)

function updateTitle(event: Event) {
  updateField('title', (event.target as HTMLInputElement).value)
}
function updateDescription(description: string | null) {
  updateField('description', description ?? '')
}
function handleLater() {
  emit('later')
}
function handleDiscard() {
  emit('discard')
}
async function handleSave() {
  if (!form.value?.reportValidity() || !commitPending()) return
  await nextTick()
  choices.value.keepAll = false
  emit('save')
}
function handleKeepAll() {
  choices.value.keepAll = true
  emit('save')
}
function commitPending() {
  return inputs.value.map((input) => input.commitPending()).every(Boolean)
}
defineExpose({ commitPending })
</script>
<template>
  <form ref="form" class="border-primary bg-card space-y-6 rounded-xl border p-4 sm:p-6" @submit.prevent="handleSave">
    <div class="space-y-1">
      <h2 class="text-lg font-semibold">{{ t('fanfiction.metadataReview.title') }}</h2>
      <p class="text-muted-foreground text-sm">{{ t('fanfiction.metadataReview.editHelp') }}</p>
    </div>
    <fieldset v-for="field in fields" :key="field" class="border-border min-w-0 border-t pt-4">
      <legend class="pr-2 font-semibold">{{ t(`fanfiction.metadataReview.fields.${field}`) }}</legend>
      <div class="mb-4 grid gap-4 text-sm sm:grid-cols-2 sm:gap-6">
        <div class="min-w-0 space-y-2">
          <p class="text-muted-foreground font-medium">{{ t('fanfiction.metadataReview.current') }}</p>
          <StoryMetadataReference :value="review.current[field]" :description="field === 'description'" />
        </div>
        <div class="min-w-0 space-y-2">
          <p class="text-muted-foreground font-medium">{{ t('fanfiction.metadataReview.incoming') }}</p>
          <StoryMetadataReference :value="review.incoming[field]" :description="field === 'description'" />
        </div>
      </div>
      <div class="space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <label v-if="field !== 'description'" class="text-sm font-medium" :for="`${id}-${field}`">{{ t('fanfiction.metadataReview.final') }}</label>
          <p v-else :id="`${id}-description-label`" class="text-sm font-medium">{{ t('fanfiction.metadataReview.final') }}</p>
          <div class="flex flex-wrap gap-1.5">
            <Button type="button" variant="outline" size="sm" :disabled="busy" @click="chooseSource(field, 'current')">{{
              t('fanfiction.metadataReview.fromLibrary')
            }}</Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              :disabled="busy || review.incoming[field] === undefined"
              @click="chooseSource(field, 'incoming')"
              >{{ t('fanfiction.metadataReview.fromIncoming') }}</Button
            >
            <Button
              v-if="field === 'authors' || field === 'genres' || field === 'tags'"
              type="button"
              variant="outline"
              size="sm"
              :disabled="busy"
              @click="combine(field)"
              >{{ t('fanfiction.metadataReview.combine') }}</Button
            >
          </div>
        </div>
        <ChipInput
          v-if="field === 'authors' || field === 'genres' || field === 'tags'"
          :key="`${field}-${inputVersions[field]}`"
          ref="inputs"
          :input-id="`${id}-${field}`"
          :model-value="finalValues[field] ?? []"
          :search-fn="field === 'tags' ? searchTags : field === 'genres' ? searchGenres : undefined"
          :split-on-separators="false"
          :max-items="field === 'authors' ? 100 : 1000"
          :disabled="busy"
          control-class="max-h-64 overflow-y-auto"
          @update:model-value="updateField(field, $event)"
        />
        <RichDescriptionEditor
          v-else-if="field === 'description'"
          :key="inputVersions.description"
          :model-value="finalValues.description"
          :disabled="busy"
          role="group"
          :aria-labelledby="`${id}-description-label`"
          @update:model-value="updateDescription"
        />
        <input
          v-else
          :id="`${id}-${field}`"
          :value="finalValues.title"
          required
          maxlength="500"
          :disabled="busy"
          class="border-input bg-background focus-visible:ring-ring min-h-11 w-full rounded-md border p-2 text-sm focus-visible:ring-1"
          @input="updateTitle"
        />
        <p v-if="review.lockedFields.includes(field)" class="text-muted-foreground flex items-start gap-1.5 text-xs">
          <LockKeyhole class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {{ t('fanfiction.metadataReview.protected') }}
        </p>
      </div>
    </fieldset>
    <slot name="actions" :save="handleSave">
      <div class="flex flex-wrap gap-2">
        <Button type="submit" :disabled="busy">{{ t(review.beforeUpdate ? 'fanfiction.metadataReview.apply' : 'common.save') }}</Button>
        <Button v-if="review.beforeUpdate" type="button" variant="outline" :disabled="busy" @click="handleKeepAll">{{
          t('fanfiction.metadataReview.keepAll')
        }}</Button>
        <Button v-if="review.beforeUpdate" type="button" variant="outline" :disabled="busy" @click="handleLater">{{
          t('fanfiction.metadataReview.later')
        }}</Button>
        <Button v-if="review.beforeUpdate" type="button" variant="ghost" :disabled="busy" @click="handleDiscard">{{
          t('fanfiction.metadataReview.discard')
        }}</Button>
      </div>
    </slot>
  </form>
</template>

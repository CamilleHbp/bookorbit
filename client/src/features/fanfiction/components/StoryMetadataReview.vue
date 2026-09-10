<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FanfictionMetadataReview, FanfictionMetadataChoices, FanfictionMetadataField } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ChipInput from '@/components/ui/ChipInput.vue'
import { useGenreSearch, useTagSearch } from '@/features/book/composables/useTagSearch'
const props = defineProps<{ review: FanfictionMetadataReview; busy: boolean }>()
const choices = defineModel<FanfictionMetadataChoices>({ required: true })
const emit = defineEmits<{ save: []; later: []; discard: [] }>()
const { t } = useI18n()
const id = useId()
const { search: searchTags } = useTagSearch()
const { search: searchGenres } = useGenreSearch()
const inputs = ref<InstanceType<typeof ChipInput>[]>([])
watch(
  () => props.review.fingerprint,
  () => {
    if (!choices.value.values) choices.value.values = JSON.parse(JSON.stringify(props.review.current))
  },
  { immediate: true },
)
const tagOptions = computed(() => [...new Set([...(props.review.tags?.managed ?? props.review.current.tags), ...props.review.incoming.tags])].sort())
const selectedTags = computed({
  get: () =>
    choices.value.tags === 'keep'
      ? (props.review.tags?.managed ?? props.review.current.tags)
      : choices.value.tags === 'merge'
        ? tagOptions.value
        : (choices.value.selectedTags ?? props.review.incoming.tags),
  set: (tags: string[]) => {
    choices.value = { ...choices.value, tags: 'select', selectedTags: tags }
  },
})
const finalTags = computed(() => [...new Set([...(props.review.tags?.custom ?? []), ...selectedTags.value])])
function display(value: string | string[] | undefined) {
  return Array.isArray(value) ? value.join(', ') : (value ?? '')
}
function finalValue(field: FanfictionMetadataField) {
  if (field === 'tags') return finalTags.value
  return choices.value[field] === 'incoming'
    ? props.review.incoming[field]
    : choices.value[field] === 'edit'
      ? choices.value.values?.[field]
      : props.review.current[field]
}
function updateList(field: 'authors' | 'genres', values: string[]) {
  if (choices.value.values) choices.value.values[field] = values
}
function keepTags() {
  choices.value.tags = 'keep'
}
function useTags() {
  selectedTags.value = [...props.review.incoming.tags]
}
function mergeTags() {
  choices.value.tags = 'merge'
}
function handleLater() {
  emit('later')
}
function handleDiscard() {
  emit('discard')
}
async function handleSave() {
  if (!inputs.value.map((input) => input.commitPending()).every(Boolean)) return
  await nextTick()
  choices.value.keepAll = false
  emit('save')
}
function handleKeepAll() {
  choices.value.keepAll = true
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
      <template v-if="field === 'tags'">
        <p v-if="review.tags?.custom.length" class="text-sm">{{ t('fanfiction.metadataReview.customTags') }}: {{ review.tags.custom.join(', ') }}</p>
        <div class="flex flex-wrap gap-2">
          <Button type="button" variant="outline" :disabled="busy || review.lockedFields.includes(field)" @click="keepTags">{{
            t('fanfiction.metadataReview.keepTags')
          }}</Button>
          <Button type="button" variant="outline" :disabled="busy || review.lockedFields.includes(field)" @click="useTags">{{
            t('fanfiction.metadataReview.useTags')
          }}</Button>
          <Button type="button" variant="outline" :disabled="busy || review.lockedFields.includes(field)" @click="mergeTags">{{
            t('fanfiction.metadataReview.mergeTags')
          }}</Button>
        </div>
        <label class="block text-sm" :for="`${id}-tags`">{{ t('fanfiction.metadataReview.final') }}</label>
        <ChipInput
          :split-on-separators="false"
          ref="inputs"
          v-model="selectedTags"
          :input-id="`${id}-tags`"
          :search-fn="searchTags"
          :max-items="1000"
          :disabled="busy || review.lockedFields.includes(field)"
        />
        <div v-if="review.tags" class="flex flex-wrap gap-2 text-xs">
          <span v-for="tag in review.tags.added" :key="`add-${tag}`" class="max-w-full rounded-full bg-muted px-2 py-1 break-words"
            >{{ t('fanfiction.metadataReview.added') }}: {{ tag }}</span
          >
          <span v-for="tag in review.tags.removed" :key="`remove-${tag}`" class="max-w-full rounded-full bg-muted px-2 py-1 break-words"
            >{{ t('fanfiction.metadataReview.removed') }}: {{ tag }}</span
          >
        </div>
      </template>
      <template v-else>
        <select
          v-model="choices[field]"
          :disabled="busy || review.lockedFields.includes(field)"
          :aria-label="t(`fanfiction.metadataReview.fields.${field}`)"
          class="border-input bg-background min-h-11 w-full rounded-md border p-2 text-sm"
        >
          <option value="keep">{{ t('fanfiction.metadataReview.keep') }}</option>
          <option value="incoming">{{ t('fanfiction.metadataReview.useIncoming') }}</option>
          <option value="edit">{{ t('fanfiction.metadataReview.edit') }}</option>
        </select>
        <template v-if="choices[field] === 'edit' && choices.values">
          <label :for="`${id}-${field}`" class="block text-sm">{{ t('fanfiction.metadataReview.final') }}</label>
          <ChipInput
            :split-on-separators="false"
            v-if="field === 'authors' || field === 'genres'"
            ref="inputs"
            :input-id="`${id}-${field}`"
            :model-value="choices.values[field] ?? []"
            :search-fn="field === 'genres' ? searchGenres : undefined"
            :max-items="field === 'authors' ? 100 : 1000"
            :disabled="busy || review.lockedFields.includes(field)"
            @update:model-value="updateList(field, $event)"
          />
          <textarea
            v-else-if="field === 'description'"
            :id="`${id}-${field}`"
            v-model="choices.values.description"
            rows="4"
            maxlength="262144"
            :disabled="busy || review.lockedFields.includes(field)"
            class="border-input bg-background w-full rounded-md border p-2"
          />
          <input
            v-else
            :id="`${id}-${field}`"
            v-model="choices.values.title"
            required
            maxlength="500"
            :disabled="busy || review.lockedFields.includes(field)"
            class="border-input bg-background min-h-11 w-full rounded-md border p-2"
          />
        </template>
      </template>
      <p class="text-sm whitespace-pre-wrap break-words">
        <strong>{{ t('fanfiction.metadataReview.final') }}:</strong> {{ display(finalValue(field)) || t('fanfiction.metadataReview.empty') }}
      </p>
      <p v-if="review.lockedFields.includes(field)" class="text-muted-foreground text-sm">{{ t('fanfiction.metadataReview.locked') }}</p>
    </fieldset>
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
  </form>
</template>

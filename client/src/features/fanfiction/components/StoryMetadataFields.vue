<script setup lang="ts">
import { ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FanfictionMetadataValues } from '@bookorbit/types'
import ChipInput from '@/components/ui/ChipInput.vue'
import { useGenreSearch, useTagSearch } from '@/features/book/composables/useTagSearch'
const values = defineModel<FanfictionMetadataValues>({ required: true })
defineProps<{ disabled?: boolean }>()
const { t } = useI18n()
const id = useId()
const { search: searchTags } = useTagSearch()
const { search: searchGenres } = useGenreSearch()
const authorInput = ref<InstanceType<typeof ChipInput>>()
const genreInput = ref<InstanceType<typeof ChipInput>>()
const tagInput = ref<InstanceType<typeof ChipInput>>()
function commitPending() {
  return [authorInput.value, genreInput.value, tagInput.value].map((input) => input?.commitPending() ?? true).every(Boolean)
}
function updateGenres(genres: string[]) {
  values.value.genres = genres
}
defineExpose({ commitPending })
</script>
<template>
  <div class="space-y-4">
    <label class="block space-y-1 text-sm"
      >{{ t('fanfiction.storyTitle') }}
      <input
        v-model="values.title"
        required
        maxlength="500"
        :disabled="disabled"
        class="border-input bg-background block min-h-11 w-full rounded-md border p-2"
      />
    </label>
    <div class="space-y-1 text-sm">
      <label :for="`${id}-authors`">{{ t('fanfiction.storyAuthors') }}</label>
      <ChipInput
        :split-on-separators="false"
        ref="authorInput"
        v-model="values.authors"
        :input-id="`${id}-authors`"
        :max-items="100"
        :disabled="disabled"
      />
    </div>
    <label class="block space-y-1 text-sm"
      >{{ t('fanfiction.storyDescription') }}
      <textarea
        v-model="values.description"
        rows="4"
        maxlength="262144"
        :disabled="disabled"
        class="border-input bg-background block w-full rounded-md border p-2"
      />
    </label>
    <div class="space-y-1 text-sm">
      <label :for="`${id}-genres`">{{ t('fanfiction.metadataReview.fields.genres') }}</label>
      <ChipInput
        :split-on-separators="false"
        ref="genreInput"
        :model-value="values.genres ?? []"
        :input-id="`${id}-genres`"
        :search-fn="searchGenres"
        :max-items="1000"
        :disabled="disabled"
        @update:model-value="updateGenres"
      />
    </div>
    <div class="space-y-1 text-sm">
      <label :for="`${id}-tags`">{{ t('fanfiction.storyTags') }}</label>
      <ChipInput
        :split-on-separators="false"
        ref="tagInput"
        v-model="values.tags"
        :input-id="`${id}-tags`"
        :search-fn="searchTags"
        :max-items="1000"
        :disabled="disabled"
      />
    </div>
  </div>
</template>

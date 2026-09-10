<script setup lang="ts">
import { useId } from 'vue'
import { useI18n } from 'vue-i18n'
import ChipInput from '@/components/ui/ChipInput.vue'
import { useGenreSearch, useTagSearch } from '@/features/book/composables/useTagSearch'
const filters = defineModel<{ publication: string; sort: string; tag: string; genre: string; fandom: string; view: string }>({ required: true })
defineProps<{ disabled?: boolean }>()
const { t } = useI18n()
const id = useId()
const { search: searchTags } = useTagSearch()
const { search: searchGenres } = useGenreSearch()
function tag(values: string[]) {
  filters.value.tag = values[0] ?? ''
}
function genre(values: string[]) {
  filters.value.genre = values[0] ?? ''
}
</script>
<template>
  <details class="w-full rounded-lg border border-border p-3">
    <summary class="cursor-pointer text-sm font-medium">{{ t('fanfiction.filters.title') }}</summary>
    <div class="grid gap-3 pt-3 sm:grid-cols-2 lg:grid-cols-3">
      <label class="space-y-1 text-sm"
        >{{ t('fanfiction.filters.view')
        }}<select v-model="filters.view" :disabled="disabled" class="border-input bg-background block min-h-11 w-full rounded-md border p-2">
          <option value="">{{ t('fanfiction.filters.all') }}</option>
          <option value="unread">{{ t('fanfiction.reading.unread') }}</option>
          <option value="new">{{ t('fanfiction.filters.new') }}</option>
          <option value="attention">{{ t('fanfiction.filters.attention') }}</option>
        </select></label
      >
      <label class="space-y-1 text-sm"
        >{{ t('fanfiction.filters.publication')
        }}<select v-model="filters.publication" :disabled="disabled" class="border-input bg-background block min-h-11 w-full rounded-md border p-2">
          <option value="">{{ t('fanfiction.filters.all') }}</option>
          <option value="ongoing">{{ t('fanfiction.filters.ongoing') }}</option>
          <option value="complete">{{ t('fanfiction.filters.complete') }}</option>
        </select></label
      >
      <label class="space-y-1 text-sm"
        >{{ t('fanfiction.filters.sort')
        }}<select v-model="filters.sort" :disabled="disabled" class="border-input bg-background block min-h-11 w-full rounded-md border p-2">
          <option value="added">{{ t('fanfiction.filters.added') }}</option>
          <option value="updated">{{ t('fanfiction.filters.updated') }}</option>
        </select></label
      >
      <div class="space-y-1 text-sm">
        <label :for="`${id}-tag`">{{ t('fanfiction.storyTags') }}</label
        ><ChipInput
          :split-on-separators="false"
          :input-id="`${id}-tag`"
          :model-value="filters.tag ? [filters.tag] : []"
          :search-fn="searchTags"
          :max-items="1"
          :disabled="disabled"
          @update:model-value="tag"
        />
      </div>
      <div class="space-y-1 text-sm">
        <label :for="`${id}-genre`">{{ t('fanfiction.metadataReview.fields.genres') }}</label
        ><ChipInput
          :split-on-separators="false"
          :input-id="`${id}-genre`"
          :model-value="filters.genre ? [filters.genre] : []"
          :search-fn="searchGenres"
          :max-items="1"
          :disabled="disabled"
          @update:model-value="genre"
        />
      </div>
      <label class="space-y-1 text-sm"
        >{{ t('fanfiction.categories.fandoms')
        }}<input
          v-model="filters.fandom"
          maxlength="500"
          :disabled="disabled"
          class="border-input bg-background block min-h-11 w-full rounded-md border p-2"
      /></label>
    </div>
  </details>
</template>

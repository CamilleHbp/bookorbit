<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import StoryDescription from './StoryDescription.vue'

const props = defineProps<{ value: string | string[] | undefined; description?: boolean }>()
const { t } = useI18n()
const expanded = ref(false)
const id = useId()
const items = computed(() => (Array.isArray(props.value) ? props.value : []))
const visibleItems = computed(() => (expanded.value ? items.value : items.value.slice(0, 6)))
const text = computed(() => (typeof props.value === 'string' ? props.value : ''))
function toggleExpanded() {
  expanded.value = !expanded.value
}
</script>
<template>
  <StoryDescription v-if="description" :description="text" />
  <div v-else-if="items.length" class="space-y-2">
    <ul :id="id" class="flex max-h-40 flex-wrap gap-1.5 overflow-auto">
      <li v-for="item in visibleItems" :key="item" class="bg-muted max-w-full rounded px-2 py-1 text-xs break-words">{{ item }}</li>
    </ul>
    <button
      v-if="items.length > 6"
      type="button"
      class="text-primary min-h-9 text-sm underline-offset-4 hover:underline focus-visible:underline"
      :aria-expanded="expanded"
      :aria-controls="id"
      @click="toggleExpanded"
    >
      {{ expanded ? t('fanfiction.metadataReview.showLess') : t('fanfiction.metadataReview.showMore', { count: items.length - 6 }) }}
    </button>
  </div>
  <p v-else class="whitespace-pre-wrap break-words" :class="!text ? 'text-muted-foreground' : ''">
    {{ text || t('fanfiction.metadataReview.empty') }}
  </p>
</template>

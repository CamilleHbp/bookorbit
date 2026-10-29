<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FanfictionCategories } from '@bookorbit/types'
const props = defineProps<{ categories?: FanfictionCategories }>()
const { t } = useI18n()
const groups = computed(() =>
  (['fandoms', 'relationships', 'characters', 'warnings', 'rating'] as const)
    .map((key) => ({
      key,
      values: key === 'rating' ? [props.categories?.rating].filter(Boolean) : (props.categories?.[key] ?? []),
    }))
    .filter((group) => group.values.length),
)
</script>
<template>
  <dl v-if="groups.length" class="space-y-3 text-sm">
    <div v-for="group in groups" :key="group.key" class="space-y-1">
      <dt class="font-medium">{{ t(`fanfiction.categories.${group.key}`) }}</dt>
      <dd class="flex flex-wrap gap-1.5">
        <span v-for="value in group.values" :key="value" class="max-w-full break-words rounded-full bg-muted px-2 py-1 text-xs">{{ value }}</span>
      </dd>
    </div>
  </dl>
</template>

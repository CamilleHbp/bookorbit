<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePermissions } from '@/features/auth/composables/usePermissions'
const props = defineProps<{ matching?: boolean }>()
const { t } = useI18n()
const { hasPermission } = usePermissions()
const EntityManagerView = defineAsyncComponent(() => import('./EntityManagerView.vue'))
const TagMatchingPanel = defineAsyncComponent(() => import('@/features/tag-matching/TagMatchingPanel.vue'))
</script>
<template>
  <div class="flex h-full min-h-0 flex-col gap-3">
    <nav v-if="hasPermission('library_edit_metadata')" :aria-label="t('tools.header.tags')" class="flex flex-wrap gap-1">
      <RouterLink
        :to="{ name: 'tools-tags' }"
        :aria-current="!props.matching ? 'page' : undefined"
        class="rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :class="!props.matching ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:bg-accent'"
        >{{ t('tools.header.tags') }}</RouterLink
      >
      <RouterLink
        :to="{ name: 'tools-tag-matching' }"
        :aria-current="props.matching ? 'page' : undefined"
        class="rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :class="props.matching ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:bg-accent'"
        >{{ t('tagMatching.title') }}</RouterLink
      >
    </nav>
    <div class="min-h-0 flex-1">
      <TagMatchingPanel v-if="props.matching" />
      <EntityManagerView v-else tags-only />
    </div>
  </div>
</template>

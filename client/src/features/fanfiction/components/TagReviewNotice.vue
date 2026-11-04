<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { usePermissions } from '@/features/auth/composables/usePermissions'
defineProps<{ count?: number }>()
const { t } = useI18n()
const { hasPermission } = usePermissions()
</script>
<template>
  <p v-if="count" class="text-sm text-muted-foreground" role="status">
    <RouterLink
      v-if="hasPermission('library_edit_metadata')"
      :to="{ name: 'tools-tag-matching', query: { view: 'review' } }"
      class="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
      >{{ t('tagMatching.pendingNotice', { count }) }}</RouterLink
    >
    <span v-else>{{ t('tagMatching.pendingNotice', { count }) }}</span>
  </p>
</template>

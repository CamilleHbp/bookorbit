<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { Permission } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import WebsiteConnections from '@/features/fanfiction/components/WebsiteConnections.vue'
const { t } = useI18n()
const { hasPermission } = usePermissions()
</script>
<template>
  <div v-if="hasPermission(Permission.ManageLibraries)" class="space-y-6">
    <WebsiteConnections />
    <details class="border-t border-border pt-4">
      <summary class="min-h-11 cursor-pointer py-3 text-sm font-medium">{{ t('fanfiction.advanced') }}</summary>
      <RouterLink :to="{ name: 'settings-fanfiction' }" class="text-sm text-primary underline">{{ t('fanfiction.maintenance.legacy') }}</RouterLink>
    </details>
  </div>
</template>

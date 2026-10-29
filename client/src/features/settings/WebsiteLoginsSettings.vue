<script setup lang="ts">
import { Permission } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import WebsiteConnections from '@/features/fanfiction/components/WebsiteConnections.vue'
const { hasPermission } = usePermissions()
</script>
<template>
  <div v-if="hasPermission(Permission.ManageLibraries)" class="space-y-6">
    <WebsiteConnections />
  </div>
</template>

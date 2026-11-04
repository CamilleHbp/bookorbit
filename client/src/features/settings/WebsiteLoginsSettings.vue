<script setup lang="ts">
import { onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { useFanfictionPreferences } from '@/features/fanfiction/composables/useFanfictionPreferences'
import { Permission } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import WebsiteConnections from '@/features/fanfiction/components/WebsiteConnections.vue'
const { hasPermission } = usePermissions()
const { t } = useI18n()
const preferences = reactive(useFanfictionPreferences())
onMounted(preferences.load)
</script>
<template>
  <div v-if="hasPermission(Permission.ManageLibraries)" class="space-y-6">
    <form class="space-y-3 rounded-xl border border-border p-4" @submit.prevent="preferences.save">
      <label class="block space-y-2 text-sm">
        <span>{{ t('fanfiction.maintenance.defaultPolicy') }}</span>
        <select
          v-model="preferences.defaultUpdatePolicy"
          :disabled="preferences.busy"
          class="block min-h-11 w-full rounded-md border border-input bg-background p-2"
        >
          <option value="safe">{{ t('fanfiction.maintenance.safe') }}</option>
          <option value="review">{{ t('fanfiction.maintenance.blockReduction') }}</option>
        </select>
      </label>
      <p class="text-sm text-muted-foreground">{{ t('fanfiction.maintenance.defaultHelp') }}</p>
      <p v-if="preferences.error" role="alert" class="text-sm text-destructive">{{ preferences.error }}</p>
      <Button type="submit" :disabled="preferences.busy">{{ t('common.save') }}</Button>
    </form>
    <WebsiteConnections />
  </div>
</template>

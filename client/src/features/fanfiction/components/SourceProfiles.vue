<script setup lang="ts">
import { toRefs, type UnwrapRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pencil, Plus, Trash2 } from '@lucide/vue'
import type { FanfictionProfileSummary } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import type { useFanfictionSettings } from '../composables/useFanfictionSettings'
import SourceProfileEditor from './SourceProfileEditor.vue'

const props = defineProps<{ settings: UnwrapRef<ReturnType<typeof useFanfictionSettings>> }>()
const emit = defineEmits<{ saved: [profile: FanfictionProfileSummary]; deleted: [id: string] }>()
const { t } = useI18n()
const { profiles, profileCursor, busy, error, health, deleting, newProfile, editProfile, moreProfiles, requestDelete, cancelDelete } = toRefs(
  props.settings,
)
function handleSaved(profile: FanfictionProfileSummary) {
  emit('saved', profile)
}
async function handleDelete() {
  const id = await props.settings.deleteProfile()
  if (id) emit('deleted', id)
}
</script>

<template>
  <section class="space-y-4" :aria-label="t('fanfiction.profiles')" :aria-busy="busy">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="space-y-1">
        <h2 class="text-lg font-medium">{{ t('fanfiction.profiles') }}</h2>
        <p class="text-sm text-muted-foreground">{{ t('fanfiction.profileHelp') }}</p>
      </div>
      <Button :disabled="busy || !health?.ready" @click="newProfile"><Plus aria-hidden="true" />{{ t('fanfiction.addProfile') }}</Button>
    </div>
    <p v-if="!busy && !profiles.length" class="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
      {{ t('fanfiction.noProfiles') }}
    </p>
    <ul v-else class="max-h-96 divide-y divide-border overflow-y-auto rounded-lg border border-border">
      <li v-for="profile in profiles" :key="profile.id" class="flex flex-wrap items-center justify-between gap-3 p-4">
        <span class="min-w-0 break-words text-sm font-medium">{{ profile.name }}</span>
        <div class="flex shrink-0 gap-2">
          <Button
            variant="outline"
            :disabled="busy || !health?.ready"
            :aria-label="t('fanfiction.editProfileNamed', { name: profile.name })"
            @click="editProfile(profile)"
          >
            <Pencil aria-hidden="true" />{{ t('fanfiction.edit') }}
          </Button>
          <Button
            variant="outline"
            class="text-destructive"
            :disabled="busy"
            :aria-label="t('fanfiction.deleteProfileNamed', { name: profile.name })"
            @click="requestDelete(profile)"
          >
            <Trash2 aria-hidden="true" />{{ t('common.delete') }}
          </Button>
        </div>
      </li>
    </ul>
    <Button v-if="profileCursor" variant="outline" :disabled="busy" @click="moreProfiles">{{ t('fanfiction.nextPage') }}</Button>
    <SourceProfileEditor :settings="settings" @saved="handleSaved" />
    <ConfirmDialog
      :open="!!deleting"
      :title="t('fanfiction.deleteProfileNamed', { name: deleting?.name ?? '' })"
      :description="t('fanfiction.deleteProfileDescription')"
      :confirm-label="t('common.delete')"
      :busy="busy"
      @confirm="handleDelete"
      @cancel="cancelDelete"
    >
      <p v-if="error" role="alert" class="mt-3 text-sm text-destructive">{{ error }}</p>
    </ConfirmDialog>
  </section>
</template>

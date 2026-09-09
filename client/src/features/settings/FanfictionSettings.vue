<script setup lang="ts">
import { computed, onMounted, reactive, toRefs } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useFanfictionSettings } from '@/features/fanfiction/composables/useFanfictionSettings'

import SourceProfiles from '@/features/fanfiction/components/SourceProfiles.vue'

import { useFanfictionPreferences } from '@/features/fanfiction/composables/useFanfictionPreferences'
const preferences = reactive(useFanfictionPreferences())
const settings = reactive(useFanfictionSettings())
const { t } = useI18n()
const { hasPermission } = usePermissions()
const canManage = computed(() => hasPermission('manage_libraries'))
const {
  libraries,
  libraryCursor,
  libraryId,
  profiles,
  health,
  jobs,
  jobCursor,
  busy,
  error,
  previewUrl,
  previewProfileId,
  loadLibraries,
  reload,
  moreJobs,
  preview,
  cancelJob,
} = toRefs(settings)
onMounted(() => {
  if (canManage.value) {
    void settings.loadLibraries()
    void preferences.load()
  }
})
</script>

<template>
  <div v-if="canManage" class="space-y-6">
    <header class="space-y-2">
      <h1 class="text-2xl font-semibold">{{ t('fanfiction.settingsTitle') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('fanfiction.settingsDescription') }}</p>
    </header>
    <p v-if="error" role="alert" class="rounded-lg border border-destructive p-3 text-sm text-destructive">{{ error }}</p>
    <section class="space-y-2 rounded-lg border border-border p-4">
      <label class="flex items-center gap-3 text-sm">
        <input v-model="preferences.isAdult" type="checkbox" :disabled="preferences.busy" @change="preferences.save" />
        <span>{{ t('fanfiction.adultConfirmation') }}</span>
      </label>
      <p class="text-sm text-muted-foreground">{{ t('fanfiction.adultGlobalHelp') }}</p>
      <p v-if="preferences.error" role="alert" class="text-sm text-destructive">{{ preferences.error }}</p>
    </section>
    <label class="block space-y-2 text-sm">
      <span>{{ t('fanfiction.library') }}</span>
      <select v-model="libraryId" :disabled="busy" class="w-full rounded-md border border-input bg-background p-2" @change="reload">
        <option v-for="library in libraries" :key="library.id" :value="library.id">{{ library.name }}</option>
      </select>
    </label>
    <Button v-if="libraryCursor" variant="outline" :disabled="busy" @click="loadLibraries">{{ t('fanfiction.moreLibraries') }}</Button>
    <p v-if="!busy && !libraries.length" class="text-sm text-muted-foreground">{{ t('fanfiction.noLibraries') }}</p>
    <template v-if="libraryId">
      <section class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
        <div>
          <h2 class="font-medium">FanFicFare</h2>
          <p class="text-sm text-muted-foreground">
            {{ health?.ready ? t('fanfiction.runtimeReady', { version: health.version }) : t('fanfiction.runtimeUnavailable') }}
          </p>
        </div>
        <Button variant="outline" :disabled="busy" @click="reload">{{ t('fanfiction.refresh') }}</Button>
      </section>
      <SourceProfiles :settings="settings" />
      <form class="space-y-3 rounded-lg border border-border p-4" @submit.prevent="preview">
        <h2 class="text-lg font-medium">{{ t('fanfiction.testSource') }}</h2>
        <label class="block space-y-1 text-sm"
          ><span>{{ t('fanfiction.storyUrl') }}</span
          ><input v-model="previewUrl" type="url" required placeholder="https://" class="w-full rounded-md border border-input bg-background p-2"
        /></label>
        <label class="block space-y-1 text-sm"
          ><span>{{ t('fanfiction.profile') }}</span
          ><select v-model="previewProfileId" class="w-full rounded-md border border-input bg-background p-2">
            <option value="">{{ t('fanfiction.noProfile') }}</option>
            <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
          </select></label
        >
        <Button type="submit" :disabled="busy || !health?.ready">{{ t('fanfiction.preview') }}</Button>
      </form>
      <section class="space-y-3">
        <h2 class="text-lg font-medium">{{ t('fanfiction.activity') }}</h2>
        <ul class="max-h-96 space-y-3 overflow-y-auto">
          <li v-for="job in jobs" :key="job.id" class="space-y-2 rounded-lg border border-border p-3">
            <div class="flex items-center justify-between gap-3">
              <p class="truncate text-sm">{{ job.result?.preview?.title || job.url }}</p>
              <span class="text-xs text-muted-foreground">{{ t(`fanfiction.states.${job.state}`) }}</span>
            </div>
            <p v-if="job.result?.preview" class="text-sm text-muted-foreground">
              {{ t('fanfiction.chapterCount', { count: job.result.preview.chapterCount }) }} · {{ job.result.preview.authors.join(', ') }}
            </p>
            <p v-if="job.errorCode" class="text-sm text-destructive">{{ t(`fanfiction.errors.${job.errorCode}`, job.errorCode) }}</p>
            <Button
              v-if="job.state === 'queued' || job.state === 'running'"
              variant="outline"
              :disabled="busy || job.cancellationRequested"
              @click="cancelJob(job)"
              >{{ t('fanfiction.cancel') }}</Button
            >
          </li>
        </ul>
        <Button v-if="jobCursor" variant="outline" :disabled="busy" @click="moreJobs">{{ t('fanfiction.more') }}</Button>
      </section>
    </template>
  </div>
</template>

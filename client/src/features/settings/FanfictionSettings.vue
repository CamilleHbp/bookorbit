<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useFanfictionSettings } from '@/features/fanfiction/composables/useFanfictionSettings'

const { t } = useI18n()
const { hasPermission } = usePermissions()
const canManage = computed(() => hasPermission('manage_libraries'))
const {
  libraries,
  libraryCursor,
  libraryId,
  profiles,
  profileCursor,
  health,
  jobs,
  jobCursor,
  busy,
  error,
  showEditor,
  name,
  configuration,
  section,
  username,
  password,
  cookies,
  cookieRows,
  cookiePage,
  moreCookies,
  changeCookies,
  addCookie,
  removeCookie,
  clearCookies,
  nextCookies,
  previousCookies,
  previewUrl,
  previewProfileId,
  loadLibraries,
  reload,
  moreProfiles,
  moreJobs,
  newProfile,
  closeEditor,
  editProfile,
  changeUsername,
  changePassword,
  clearPassword,
  saveProfile,
  preview,
  cancelJob,
} = useFanfictionSettings()
onMounted(() => {
  if (canManage.value) void loadLibraries()
})
</script>

<template>
  <div v-if="canManage" class="space-y-6">
    <header class="space-y-2">
      <h1 class="text-2xl font-semibold">{{ t('fanfiction.settingsTitle') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('fanfiction.settingsDescription') }}</p>
    </header>
    <p v-if="error" role="alert" class="rounded-lg border border-destructive p-3 text-sm text-destructive">{{ error }}</p>
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
      <section class="space-y-3">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-lg font-medium">{{ t('fanfiction.profiles') }}</h2>
          <Button :disabled="busy || !health?.ready" @click="newProfile">{{ t('fanfiction.addProfile') }}</Button>
        </div>
        <p class="text-sm text-muted-foreground">{{ t('fanfiction.profileHelp') }}</p>
        <ul class="max-h-80 overflow-y-auto divide-y divide-border rounded-lg border border-border">
          <li v-for="profile in profiles" :key="profile.id" class="flex items-center justify-between gap-3 p-3">
            <span class="truncate text-sm">{{ profile.name }}</span>
            <Button variant="outline" :disabled="busy || !health?.ready" @click="editProfile(profile)">{{ t('fanfiction.edit') }}</Button>
          </li>
        </ul>
        <Button v-if="profileCursor" variant="outline" :disabled="busy" @click="moreProfiles">{{ t('fanfiction.more') }}</Button>
      </section>
      <form v-if="showEditor" class="space-y-4 rounded-lg border border-border bg-card p-4" @submit.prevent="saveProfile">
        <label class="block space-y-1 text-sm"
          ><span>{{ t('fanfiction.profileName') }}</span
          ><input v-model="name" required maxlength="120" class="w-full rounded-md border border-input bg-background p-2"
        /></label>
        <div class="grid gap-3 md:grid-cols-3">
          <label class="block space-y-1 text-sm"
            ><span>{{ t('fanfiction.siteSection') }}</span
            ><input v-model="section" maxlength="255" class="w-full rounded-md border border-input bg-background p-2"
          /></label>
          <label class="block space-y-1 text-sm"
            ><span>{{ t('fanfiction.username') }}</span
            ><input v-model="username" autocomplete="off" class="w-full rounded-md border border-input bg-background p-2" @input="changeUsername"
          /></label>
          <label class="block space-y-1 text-sm"
            ><span>{{ t('fanfiction.password') }}</span
            ><input
              v-model="password"
              type="password"
              autocomplete="new-password"
              placeholder="********"
              class="w-full rounded-md border border-input bg-background p-2"
              @input="changePassword"
          /></label>
        </div>
        <Button type="button" variant="outline" @click="clearPassword">{{ t('fanfiction.clearPassword') }}</Button>
        <fieldset class="space-y-3 rounded-lg border border-border p-3">
          <legend class="px-1 text-sm font-medium">{{ t('fanfiction.cookiesTitle') }}</legend>
          <p class="text-xs text-muted-foreground">{{ t('fanfiction.cookiesHelp') }}</p>
          <div v-for="cookie in cookieRows" :key="cookie.key" class="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
            <label class="block space-y-1 text-sm"
              ><span>{{ t('fanfiction.cookieName') }}</span>
              <input
                v-model="cookie.name"
                required
                maxlength="256"
                class="w-full rounded-md border border-input bg-background p-2"
                @input="changeCookies"
              />
            </label>
            <label class="block space-y-1 text-sm"
              ><span>{{ t('fanfiction.cookieDomain') }}</span>
              <input
                v-model="cookie.domain"
                required
                maxlength="255"
                placeholder="archiveofourown.org"
                class="w-full rounded-md border border-input bg-background p-2"
                @input="changeCookies"
              />
            </label>
            <label class="block space-y-1 text-sm"
              ><span>{{ t('fanfiction.cookieValue') }}</span>
              <input
                v-model="cookie.value"
                type="password"
                autocomplete="new-password"
                maxlength="4096"
                class="w-full rounded-md border border-input bg-background p-2"
                @input="changeCookies"
              />
            </label>
            <label class="block space-y-1 text-sm"
              ><span>{{ t('fanfiction.cookiePath') }}</span>
              <input
                v-model="cookie.path"
                required
                maxlength="4096"
                class="w-full rounded-md border border-input bg-background p-2"
                @input="changeCookies"
              />
            </label>
            <Button type="button" variant="outline" :disabled="busy" @click="removeCookie(cookie.key)">{{ t('fanfiction.removeCookie') }}</Button>
          </div>
          <div class="flex flex-wrap gap-2">
            <Button type="button" variant="outline" :disabled="busy || cookies.length >= 200" @click="addCookie">{{
              t('fanfiction.addCookie')
            }}</Button>
            <Button v-if="cookies.length" type="button" variant="outline" :disabled="busy" @click="clearCookies">{{
              t('fanfiction.clearCookies')
            }}</Button>
            <Button v-if="cookiePage > 0" type="button" variant="outline" @click="previousCookies">{{ t('fanfiction.previousCookies') }}</Button>
            <Button v-if="moreCookies" type="button" variant="outline" @click="nextCookies">{{ t('fanfiction.nextCookies') }}</Button>
          </div>
        </fieldset>
        <label class="block space-y-1 text-sm"
          ><span>{{ t('fanfiction.advanced') }}</span
          ><textarea
            v-model="configuration"
            rows="10"
            maxlength="65536"
            spellcheck="false"
            class="w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
          />
        </label>
        <p class="text-xs text-muted-foreground">{{ t('fanfiction.secretHelp') }}</p>
        <div class="flex gap-2">
          <Button type="submit" :disabled="busy">{{ t('fanfiction.save') }}</Button
          ><Button type="button" variant="outline" :disabled="busy" @click="closeEditor">{{ t('fanfiction.cancel') }}</Button>
        </div>
      </form>
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

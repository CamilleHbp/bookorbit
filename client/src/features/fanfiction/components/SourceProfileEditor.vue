<script setup lang="ts">
import { toRefs, type UnwrapRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FanfictionProfileSummary } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import type { useFanfictionSettings } from '../composables/useFanfictionSettings'
import { sourcePresets } from '../lib/source-presets'
const props = defineProps<{ settings: UnwrapRef<ReturnType<typeof useFanfictionSettings>> }>()
const emit = defineEmits<{ saved: [profile: FanfictionProfileSummary] }>()
const { t } = useI18n()
const {
  editing,
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
  closeEditor,
  changeUsername,
  changePassword,
  clearPassword,
  busy,
  presetId,
  preset,
  isAdult,
  changeAdult,
  applyPreset,
  readSection,
} = toRefs(props.settings)
async function save() {
  const profile = await props.settings.saveProfile()
  if (profile) emit('saved', profile)
}
</script>
<template>
  <form v-if="showEditor" class="space-y-4 rounded-lg border border-border bg-card p-4" @submit.prevent="save">
    <fieldset :disabled="busy" class="space-y-4">
      <div class="space-y-2">
        <h2 class="text-lg font-medium">{{ t(editing ? 'fanfiction.editSource' : 'fanfiction.addProfile') }}</h2>
        <label v-if="!editing" class="block space-y-1 text-sm">
          <span>{{ t('fanfiction.chooseSite') }}</span>
          <select v-model="presetId" class="w-full rounded-md border border-input bg-background p-2" @change="applyPreset">
            <option value="">{{ t('fanfiction.customSource') }}</option>
            <option v-for="site in sourcePresets" :key="site.id" :value="site.id">{{ site.name }}</option>
          </select>
        </label>
        <p v-if="preset" class="text-sm text-muted-foreground">{{ t(`fanfiction.presets.${preset.id}`) }}</p>
      </div>
      <label class="block space-y-1 text-sm"
        ><span>{{ t('fanfiction.profileName') }}</span
        ><input v-model="name" required maxlength="120" class="w-full rounded-md border border-input bg-background p-2"
      /></label>
      <div v-if="!preset || preset.login" class="grid gap-3 sm:grid-cols-2">
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
      <Button v-if="!preset || preset.login" type="button" variant="outline" @click="clearPassword">{{ t('fanfiction.clearPassword') }}</Button>
      <label class="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
        <input v-model="isAdult" type="checkbox" class="mt-1" @change="changeAdult" />
        <span
          ><span class="block font-medium">{{ t('fanfiction.adultConfirmation') }}</span>
          <span class="text-muted-foreground">{{ t('fanfiction.adultHelp') }}</span></span
        >
      </label>
      <details class="space-y-3 rounded-lg border border-border p-3">
        <summary class="cursor-pointer text-sm font-medium">{{ t('fanfiction.advancedSettings') }}</summary>
        <p class="text-xs text-muted-foreground">{{ t('fanfiction.advancedHelp') }}</p>
        <label class="block space-y-1 text-sm"
          ><span>{{ t('fanfiction.siteSection') }}</span>
          <input v-model="section" required maxlength="255" class="w-full rounded-md border border-input bg-background p-2" @change="readSection" />
        </label>
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
      </details>
      <p class="text-xs text-muted-foreground">{{ t('fanfiction.secretHelp') }}</p>
      <div class="flex gap-2">
        <Button type="submit" :disabled="busy">{{ t('fanfiction.save') }}</Button
        ><Button type="button" variant="outline" :disabled="busy" @click="closeEditor">{{ t('fanfiction.cancel') }}</Button>
      </div>
    </fieldset>
  </form>
</template>

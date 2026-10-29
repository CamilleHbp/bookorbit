<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FanfictionConnection, FanfictionJob, FanfictionSource } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { useWebsiteConnections } from '../composables/useWebsiteConnections'
const props = defineProps<{ libraryId?: number; focusSite?: string; source?: FanfictionSource; repairsOnly?: boolean }>()
const emit = defineEmits<{ saved: [connection: FanfictionConnection, job?: FanfictionJob]; cancel: [] }>()
const { t } = useI18n()
const state = useWebsiteConnections(() => props.libraryId)
const {
  configuration,
  tagRules,
  settingsLoaded,
  settingsLoading,
  loadSettings,
  addTagRule,
  removeTagRule,
  websites,
  connections,
  issues,
  site,
  username,
  password,
  cookieName,
  cookieValue,
  error,
  busy,
  saved,
  website,
  connection,
  affected,
  reload,
  remove,
} = state
function toggleSettings(event: Event) {
  if ((event.target as HTMLDetailsElement).open) void loadSettings()
}
const removing = ref(false)
function requestRemoval() {
  removing.value = true
}
function cancelRemoval() {
  removing.value = false
}
const editor = ref<HTMLElement | null>(null)
const rows = computed(() =>
  props.repairsOnly
    ? issues.value.map((issue) => ({
        site: issue.site,
        count: issue.count,
        login: connections.value.find((item) => item.website.id === issue.site),
        name: websites.value.find((item) => item.id === issue.site)?.name ?? issue.site,
      }))
    : connections.value.map((login) => ({ site: login.website.id, count: 0, login, name: login.website.name })),
)
const focusRequested = ref(false)
watch(
  [editor, focusRequested],
  ([element, requested]) => {
    if (element && requested) {
      element.focus()
      focusRequested.value = false
    }
  },
  { flush: 'post' },
)
function edit(value: string) {
  focusRequested.value = true
  state.select(value)
}
defineExpose({ reload })
watch(
  () => props.focusSite,
  (value) => {
    if (value) void edit(value)
  },
  { immediate: true },
)
async function save() {
  const result = await state.save(props.source)
  if (result) emit('saved', result.connection, result.job)
}
function cancel() {
  state.select('')
  emit('cancel')
}
function date(value: string) {
  return new Date(value).toLocaleString()
}
</script>
<template>
  <section v-if="!repairsOnly || rows.length || site || error" class="space-y-4" :aria-label="t('fanfiction.connections.title')">
    <header v-if="repairsOnly || error" class="flex flex-wrap items-center justify-between gap-3">
      <h2 v-if="repairsOnly" class="text-lg font-semibold">{{ t('fanfiction.connections.attention') }}</h2>
      <Button v-if="error" variant="outline" :disabled="busy" @click="reload">{{ t('fanfiction.retry') }}</Button>
    </header>
    <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
    <p v-if="busy && !websites.length" role="status" class="text-sm text-muted-foreground">{{ t('common.loading') }}</p>
    <ul v-if="rows.length" class="divide-y divide-border">
      <li v-for="row in rows" :key="row.site" class="flex flex-wrap items-center justify-between gap-3 py-4">
        <div class="min-w-0 space-y-1">
          <p class="break-words font-medium">{{ row.name }}</p>
          <p v-if="row.count" class="text-sm text-muted-foreground">{{ t('fanfiction.connections.affected', { count: row.count }) }}</p>
          <p v-else-if="row.login?.errorCode" class="text-sm text-destructive">{{ t(`fanfiction.errors.${row.login.errorCode}`) }}</p>
          <p v-else class="text-sm text-muted-foreground">
            {{
              row.login?.lastSuccessfulAt
                ? t('fanfiction.connections.success', { date: date(row.login.lastSuccessfulAt) })
                : t('fanfiction.connections.unverified')
            }}
          </p>
        </div>
        <Button variant="outline" :disabled="busy" @click="edit(row.site)">{{ t(row.count ? 'fanfiction.bulk.fixLogin' : 'common.edit') }}</Button>
      </li>
    </ul>
    <label v-if="!repairsOnly" class="block max-w-lg space-y-1 text-sm"
      >{{ t('fanfiction.connections.website') }}
      <select v-model="site" :disabled="busy" class="border-input bg-background block min-h-11 w-full rounded-md border px-3">
        <option value="">{{ t('fanfiction.connections.choose') }}</option>
        <option v-for="item in websites" :key="item.id" :value="item.id">{{ item.name }}</option>
      </select>
    </label>
    <form
      v-if="website"
      ref="editor"
      tabindex="-1"
      class="max-w-xl space-y-4 rounded-xl border border-border p-4 focus:outline-none"
      @submit.prevent="save"
    >
      <h3 class="font-semibold">{{ website.name }}</h3>
      <p v-if="source" class="text-sm text-muted-foreground">{{ t('fanfiction.connections.takeOver', { title: source.title }) }}</p>
      <p v-if="connection" class="text-sm text-muted-foreground">{{ t('fanfiction.connections.savedHelp') }}</p>
      <template v-if="website.access === 'login'">
        <label class="block space-y-1 text-sm"
          >{{ t('fanfiction.connections.username')
          }}<input
            v-model="username"
            autocomplete="username"
            maxlength="4096"
            :disabled="busy"
            class="border-input bg-background block min-h-11 w-full rounded-md border px-3"
        /></label>
        <label class="block space-y-1 text-sm"
          >{{ t('fanfiction.connections.password')
          }}<input
            v-model="password"
            type="password"
            autocomplete="new-password"
            maxlength="4096"
            :disabled="busy"
            class="border-input bg-background block min-h-11 w-full rounded-md border px-3"
        /></label>
      </template>
      <details :open="website.access === 'cookies'" class="space-y-3">
        <summary class="min-h-11 cursor-pointer py-3 text-sm font-medium">{{ t('fanfiction.connections.cookies') }}</summary>
        <p class="text-sm text-muted-foreground">{{ t('fanfiction.connections.cookieHelp') }}</p>
        <label class="block space-y-1 text-sm"
          >{{ t('fanfiction.connections.cookieName')
          }}<input
            v-model="cookieName"
            autocomplete="off"
            :disabled="busy"
            class="border-input bg-background block min-h-11 w-full rounded-md border px-3"
        /></label>
        <label class="block space-y-1 text-sm"
          >{{ t('fanfiction.connections.cookieValue')
          }}<input
            v-model="cookieValue"
            type="password"
            autocomplete="off"
            :disabled="busy"
            class="border-input bg-background block min-h-11 w-full rounded-md border px-3"
        /></label>
      </details>
      <details v-if="!repairsOnly" :key="site" class="space-y-3" @toggle="toggleSettings">
        <summary class="min-h-11 cursor-pointer py-3 text-sm font-medium">{{ t('fanfiction.advanced') }}</summary>
        <p v-if="settingsLoading" role="status" class="text-sm text-muted-foreground">{{ t('common.loading') }}</p>
        <template v-if="settingsLoaded">
          <label class="block space-y-1 text-sm"
            >{{ t('fanfiction.advancedSettings') }}
            <textarea
              v-model="configuration"
              :disabled="busy"
              rows="6"
              maxlength="65536"
              spellcheck="false"
              class="border-input bg-background block w-full rounded-md border p-3 font-mono text-sm"
            />
          </label>
          <fieldset class="space-y-3">
            <legend class="text-sm font-medium">{{ t('fanfiction.tagRules') }}</legend>
            <div v-for="(rule, index) in tagRules" :key="index" class="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label class="min-w-0 flex-1 text-sm"
                >{{ t('fanfiction.remoteTag')
                }}<input
                  v-model="rule.remoteTag"
                  required
                  maxlength="500"
                  :disabled="busy"
                  class="border-input bg-background block min-h-11 w-full rounded-md border px-3"
              /></label>
              <label class="min-w-0 flex-1 text-sm"
                >{{ t('fanfiction.targetTag')
                }}<input
                  v-model="rule.targetTag"
                  required
                  maxlength="500"
                  :disabled="busy"
                  class="border-input bg-background block min-h-11 w-full rounded-md border px-3"
              /></label>
              <Button type="button" variant="ghost" class="self-start sm:self-auto" :disabled="busy" @click="removeTagRule(index)">{{
                t('fanfiction.removeTagRule')
              }}</Button>
            </div>
            <Button type="button" variant="outline" :disabled="busy || tagRules.length >= 100" @click="addTagRule">{{
              t('fanfiction.addTagRule')
            }}</Button>
          </fieldset>
        </template>
        <Button v-else-if="!settingsLoading" type="button" variant="outline" @click="loadSettings">{{ t('fanfiction.retry') }}</Button>
      </details>
      <div v-if="connection && !repairsOnly" class="space-y-2 border-t border-border pt-3">
        <template v-if="removing"
          ><p class="text-sm">{{ t('fanfiction.connections.removeHelp') }}</p>
          <div class="flex flex-wrap gap-2">
            <Button type="button" variant="destructive" :disabled="busy" @click="remove">{{ t('fanfiction.connections.remove') }}</Button
            ><Button type="button" variant="outline" @click="cancelRemoval">{{ t('common.cancel') }}</Button>
          </div></template
        >
        <Button v-else type="button" variant="ghost" :disabled="busy" @click="requestRemoval">{{ t('fanfiction.connections.remove') }}</Button>
      </div>
      <p v-if="saved" role="status" class="text-sm">{{ t('fanfiction.connections.saved') }}</p>
      <div class="flex flex-wrap gap-2">
        <Button type="submit" :disabled="busy">{{
          t(libraryId && (affected || source) ? 'fanfiction.connections.saveRetry' : 'common.save')
        }}</Button>
        <Button type="button" variant="outline" :disabled="busy" @click="cancel">{{ t('common.cancel') }}</Button>
      </div>
    </form>
  </section>
</template>

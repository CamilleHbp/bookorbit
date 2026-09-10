<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { FanfictionJob, FanfictionLinkPreview, FanfictionProfileSummary, FanfictionProfilePage } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import StorySchedule from './StorySchedule.vue'
const props = defineProps<{ bookId: number; bookFileId: number; libraryId: number }>()
const { t } = useI18n()
const url = ref('')
const schedule = ref('manual')
const preview = ref<FanfictionLinkPreview | null>(null)
const job = ref<FanfictionJob | null>(null)
const busy = ref(false)
const error = ref('')
const key = ref(crypto.randomUUID())
const profileId = ref('')
const profiles = ref<FanfictionProfileSummary[]>([])
const profileCursor = ref<string | null>(null)
const profilesLoaded = ref(false)
watch([url, profileId], () => {
  preview.value = null
  job.value = null
  key.value = crypto.randomUUID()
})
async function loadProfiles() {
  try {
    const response = await api(
      `/api/v1/libraries/${props.libraryId}/fanfiction/profiles?limit=50${profileCursor.value ? `&cursor=${profileCursor.value}` : ''}`,
    )
    if (!response.ok) throw new Error('Could not load profiles')
    const page: FanfictionProfilePage = await response.json()
    profiles.value.push(...page.items)
    profileCursor.value = page.nextCursor
    profilesLoaded.value = true
  } catch {
    error.value = t('fanfiction.link.failed')
  }
}

function toggle(event: Event) {
  if ((event.target as HTMLDetailsElement).open && !profilesLoaded.value) void loadProfiles()
}

async function request(path: string, body: unknown) {
  const response = await api(`/api/v1/libraries/${props.libraryId}/fanfiction/discovery${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.message ?? t('fanfiction.link.failed'))
  return result
}
async function inspect() {
  busy.value = true
  error.value = ''
  preview.value = null
  job.value = null
  try {
    preview.value = await request('/book', {
      bookId: props.bookId,
      bookFileId: props.bookFileId,
      url: url.value,
      ...(profileId.value ? { profileId: profileId.value } : {}),
    })
    key.value = crypto.randomUUID()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('fanfiction.link.failed')
  } finally {
    busy.value = false
  }
}
async function link() {
  if (!preview.value) return
  busy.value = true
  error.value = ''
  try {
    job.value = await request('/selection', {
      idempotencyKey: key.value,
      ids: [preview.value.id],
      state: 'pending',
      decision: 'approve',
      ...(profileId.value ? { profileId: profileId.value } : {}),
      canonicalUrl: preview.value.canonicalUrl,
      intervalMinutes: schedule.value === 'manual' ? null : Number(schedule.value),
    })
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('fanfiction.link.failed')
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <details @toggle="toggle" class="my-4 rounded-xl border border-border p-4">
    <summary class="cursor-pointer text-sm font-medium">{{ t('fanfiction.link.title') }}</summary>
    <form class="mt-4 space-y-3" @submit.prevent="inspect">
      <label class="block space-y-1 text-sm"
        >{{ t('fanfiction.link.url')
        }}<input
          v-model="url"
          required
          type="url"
          maxlength="4096"
          :disabled="busy"
          class="border-input bg-background block min-h-11 w-full rounded-md border p-2"
      /></label>
      <label class="block space-y-1 text-sm"
        >{{ t('fanfiction.profile')
        }}<select v-model="profileId" :disabled="busy" class="border-input bg-background block min-h-11 w-full rounded-md border p-2">
          <option value="">{{ t('fanfiction.noProfile') }}</option>
          <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
        </select></label
      >
      <Button v-if="profileCursor" type="button" variant="ghost" @click="loadProfiles">{{ t('fanfiction.moreProfiles') }}</Button>
      <Button type="submit" variant="outline" :disabled="busy">{{ t('fanfiction.link.inspect') }}</Button>
    </form>
    <form v-if="preview && !job" class="mt-4 space-y-3" @submit.prevent="link">
      <p class="text-sm text-muted-foreground">{{ t('fanfiction.metadataReview.current') }}</p>
      <p class="font-medium">{{ preview.title }}</p>
      <p class="text-sm">{{ preview.authors.join(', ') }} · {{ t('fanfiction.chapterCount', { count: preview.chapterCount }) }}</p>
      <p class="break-all text-sm">{{ preview.canonicalUrl }}</p>
      <div class="rounded-lg bg-muted p-3">
        <p class="text-sm text-muted-foreground">{{ t('fanfiction.metadataReview.incoming') }}</p>
        <p class="font-medium">{{ preview.remote.title }}</p>
        <p class="text-sm">{{ preview.remote.authors.join(', ') }} · {{ t('fanfiction.chapterCount', { count: preview.remote.chapterCount }) }}</p>
      </div>
      <StorySchedule v-model="schedule" :disabled="busy" />
      <Button type="submit" :disabled="busy">{{ t('fanfiction.link.confirm') }}</Button>
    </form>
    <p v-if="error" role="alert" class="mt-3 text-sm text-destructive">{{ error }}</p>
    <p v-if="job" role="status" class="mt-3 text-sm">
      {{ t('fanfiction.link.queued') }}
      <RouterLink :to="{ name: 'fanfiction', query: { libraryId, tab: 'activity' } }" class="text-primary underline">{{
        t('fanfiction.activity')
      }}</RouterLink>
    </p>
  </details>
</template>

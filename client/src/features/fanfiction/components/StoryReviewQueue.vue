<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Permission, type FanfictionReviewScope } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useStoryReviewQueue } from '../composables/useStoryReviewQueue'
import StoryMetadataReview from './StoryMetadataReview.vue'
import StoryMetadataFields from './StoryMetadataFields.vue'
import StoryReviewActions from './StoryReviewActions.vue'

const props = defineProps<{ libraryId: number }>()
const { t } = useI18n()
const { hasPermission } = usePermissions()
const scope = ref<FanfictionReviewScope>('pending')
const queue = useStoryReviewQueue(toRef(props, 'libraryId'), scope)
const { current, busy, error, finished, position, hasPrevious, savedCount, skippedCount, save, retry, restart, reloadCurrent } = queue
const heading = ref<HTMLElement>()
const reviewEditor = ref<InstanceType<typeof StoryMetadataReview>>()
const fields = ref<InstanceType<typeof StoryMetadataFields>>()
const form = ref<HTMLFormElement>()
const canSave = computed(() => Boolean(current.value?.review) || hasPermission(Permission.LibraryEditMetadata))
const summary = computed(() => t('fanfiction.reviewQueue.summary', { saved: savedCount.value, skipped: skippedCount.value }))
function changeScope(event: Event) {
  const select = event.target as HTMLSelectElement
  if (queue.confirmLeave()) scope.value = select.value as FanfictionReviewScope
  else select.value = scope.value
}
async function saveFields() {
  if (!canSave.value || !form.value?.reportValidity() || !fields.value?.commitPending()) return
  await nextTick()
  await save()
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (queue.hasDrafts.value || busy.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
function canLeave() {
  if (busy.value) return false
  const committed = current.value?.review ? reviewEditor.value?.commitPending() : fields.value?.commitPending()
  if (committed === false) return false
  return !busy.value && queue.confirmLeave()
}
async function commitDraft() {
  const committed = current.value?.review ? reviewEditor.value?.commitPending() : fields.value?.commitPending()
  await nextTick()
  return committed !== false
}
async function next() {
  if (await commitDraft()) await queue.next()
}
async function previous() {
  if (await commitDraft()) await queue.previous()
}
defineExpose({ canLeave })
watch(
  () => current.value?.source.id,
  async () => {
    await nextTick()
    heading.value?.focus()
  },
)
onBeforeRouteLeave(canLeave)
onBeforeRouteUpdate(canLeave)
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>
<template>
  <section class="mx-auto w-full max-w-4xl space-y-5" :aria-label="t('fanfiction.reviewQueue.title')" :aria-busy="busy">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div class="space-y-1">
        <h2 class="text-xl font-semibold">{{ t('fanfiction.reviewQueue.title') }}</h2>
        <p class="text-sm text-muted-foreground" role="status">{{ summary }}</p>
      </div>
      <label class="space-y-1 text-sm">
        <span class="block">{{ t('fanfiction.reviewQueue.scope') }}</span>
        <select
          :value="scope"
          :disabled="busy"
          class="min-h-11 rounded-md border border-input bg-background px-3 focus-visible:outline-2 focus-visible:outline-ring"
          @change="changeScope"
        >
          <option value="pending">{{ t('fanfiction.reviewQueue.pending') }}</option>
          <option value="all">{{ t('fanfiction.reviewQueue.all') }}</option>
        </select>
      </label>
    </header>
    <div v-if="error" class="space-y-3" role="alert">
      <p class="text-sm text-destructive">{{ error }}</p>
      <Button v-if="!current?.loaded" variant="outline" :disabled="busy" @click="retry">{{ t('fanfiction.retry') }}</Button>
      <Button v-if="current?.loaded" variant="ghost" :disabled="busy" @click="reloadCurrent">{{ t('fanfiction.reviewQueue.reload') }}</Button>
    </div>
    <div v-if="finished" class="space-y-4 py-12 text-center" role="status">
      <h3 ref="heading" tabindex="-1" class="text-lg font-semibold">
        {{ t(savedCount || skippedCount ? 'fanfiction.reviewQueue.finished' : 'fanfiction.reviewQueue.empty') }}
      </h3>
      <p v-if="skippedCount" class="text-sm text-muted-foreground">{{ t('fanfiction.reviewQueue.skippedRemain') }}</p>
      <div class="flex flex-wrap justify-center gap-2">
        <Button v-if="hasPrevious" variant="outline" @click="previous">{{ t('common.previous') }}</Button>
        <Button variant="outline" @click="restart">{{ t('fanfiction.reviewQueue.startAgain') }}</Button>
      </div>
    </div>
    <template v-else-if="current">
      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>{{ t('fanfiction.reviewQueue.position', { count: position }) }}</span>
          <span v-if="current.saved" class="text-foreground">{{ t('fanfiction.reviewQueue.saved') }}</span>
        </div>
        <h3 ref="heading" tabindex="-1" class="break-words text-xl font-semibold focus:outline-none">
          {{ current.source.title }}
        </h3>
        <a
          :href="current.source.canonicalUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-block min-h-11 max-w-full break-words py-2 text-sm text-primary underline underline-offset-4"
          >{{ current.source.site }}</a
        >
      </div>
      <p v-if="!current.loaded && busy" role="status" class="py-8 text-sm text-muted-foreground">{{ t('common.loading') }}</p>
      <StoryMetadataReview
        v-else-if="current.review"
        ref="reviewEditor"
        :key="current.source.id"
        v-model="current.choices"
        :review="current.review.review"
        :busy="busy || current.saved"
        @save="save"
      >
        <template #actions="{ save: submitReview }">
          <StoryReviewActions
            :busy="busy"
            :has-previous="hasPrevious"
            :saved="current.saved"
            :can-save="true"
            @previous="previous"
            @skip="next"
            @save="submitReview"
          />
        </template>
      </StoryMetadataReview>
      <form v-else-if="current.loaded" ref="form" class="space-y-5 rounded-xl border border-border bg-card p-4" @submit.prevent="saveFields">
        <p v-if="!canSave" class="text-sm text-muted-foreground">{{ t('fanfiction.reviewQueue.readOnly') }}</p>
        <p v-else-if="current.lockedFields.length" class="text-sm text-muted-foreground">{{ t('fanfiction.reviewQueue.locked') }}</p>
        <StoryMetadataFields
          ref="fields"
          :key="current.source.id"
          v-model="current.values"
          :locked-fields="current.lockedFields"
          :disabled="busy || current.saved || !canSave"
        />
        <StoryReviewActions
          :busy="busy"
          :has-previous="hasPrevious"
          :saved="current.saved"
          :can-save="canSave"
          @previous="previous"
          @skip="next"
          @save="saveFields"
        />
      </form>
      <div v-else-if="!busy" class="rounded-xl border border-border bg-card p-4">
        <StoryReviewActions :busy="busy" :has-previous="hasPrevious" :can-save="false" @previous="previous" @skip="next" />
      </div>
    </template>
    <p v-else-if="busy" role="status" class="py-8 text-sm text-muted-foreground">{{ t('common.loading') }}</p>
  </section>
</template>

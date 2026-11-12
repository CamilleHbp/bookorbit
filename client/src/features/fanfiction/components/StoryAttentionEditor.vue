<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Permission, isFanfictionWebsiteAccessProblem, type FanfictionSource } from '@bookorbit/types'
import StoryReviewActions from './StoryReviewActions.vue'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useBookStory } from '../composables/useBookStory'
import StoryUpdatesTab from './StoryUpdatesTab.vue'

const props = defineProps<{ source: FanfictionSource; busy: boolean; hasPrevious?: boolean }>()
const emit = defineEmits<{ next: [resolved: boolean]; previous: []; excluded: [] }>()
const { t } = useI18n()
const { hasPermission } = usePermissions()
const state = useBookStory(
  () => props.source.bookId ?? 0,
  () => props.source.libraryId,
  () => hasPermission(Permission.ManageLibraries),
  undefined,
  props.source.id,
)
const editor = ref<InstanceType<typeof StoryUpdatesTab>>()
const baseline = ref('')
const snapshot = () => JSON.stringify(state.metadataChoices.value)
watch(
  state.metadataReview,
  () => {
    baseline.value = snapshot()
  },
  { flush: 'post' },
)
const working = computed(() => props.busy || state.busy.value || state.loading.value)
const websiteBlocked = computed(
  () => isFanfictionWebsiteAccessProblem(state.source.value?.attentionCode) || isFanfictionWebsiteAccessProblem(state.job.value?.errorCode),
)
watch([websiteBlocked, working], ([blocked, busy]) => {
  if (blocked && !busy) emit('excluded')
})
function previous() {
  emit('previous')
}
const running = computed(() => state.job.value && ['queued', 'running'].includes(state.job.value.state))
const resolved = computed(() => {
  const source = state.source.value
  return Boolean(
    source &&
    !state.error.value &&
    !source.attentionCode &&
    !source.metadataReviewPending &&
    !['review_required', 'configuration_blocked'].includes(source.state) &&
    !running.value,
  )
})
const hasDrafts = computed(() => Boolean(state.replacementFile.value) || Boolean(state.metadataReview.value && snapshot() !== baseline.value))
function hasUnsavedInput() {
  const committed = editor.value?.commitPending()
  return committed === false || hasDrafts.value || working.value
}
function canLeave() {
  if (working.value || editor.value?.commitPending() === false) return false
  return !hasDrafts.value || window.confirm(t('fanfiction.reviewQueue.discardDrafts'))
}
function next() {
  if (canLeave()) emit('next', resolved.value)
}
function reviewed() {
  baseline.value = snapshot()
  emit('next', resolved.value)
}
defineExpose({ canLeave, hasUnsavedInput })
</script>
<template>
  <div v-if="!websiteBlocked" class="space-y-4">
    <StoryUpdatesTab v-if="source.bookId" ref="editor" :state="state" review-mode @reviewed="reviewed" @skip="next">
      <template #review-actions="{ save: submitReview }">
        <StoryReviewActions
          :busy="working"
          :has-previous="Boolean(hasPrevious)"
          :can-save="true"
          @save="submitReview"
          @skip="next"
          @previous="previous"
        />
      </template>
    </StoryUpdatesTab>
    <div v-if="!state.metadataReview.value" class="space-y-2">
      <p role="status" class="text-sm text-muted-foreground">
        {{
          t(resolved ? 'fanfiction.attentionReview.resolved' : running ? 'fanfiction.attentionReview.running' : 'fanfiction.attentionReview.pending')
        }}
      </p>
      <StoryReviewActions
        :busy="working"
        :has-previous="Boolean(hasPrevious)"
        :can-save="false"
        :saved="resolved || Boolean(running)"
        @skip="next"
        @previous="previous"
      />
    </div>
  </div>
</template>

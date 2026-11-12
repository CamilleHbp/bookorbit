<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Permission, type FanfictionSource } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useBookStory } from '../composables/useBookStory'
import StoryUpdatesTab from './StoryUpdatesTab.vue'

const props = defineProps<{ source: FanfictionSource; busy: boolean }>()
const emit = defineEmits<{ next: [resolved: boolean] }>()
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
  <div class="space-y-4">
    <StoryUpdatesTab v-if="source.bookId" ref="editor" :state="state" review-mode @reviewed="reviewed" @skip="next" />
    <Button v-else as-child
      ><RouterLink :to="{ name: 'fanfiction', query: { tab: 'review', review: 'imports', libraryId: source.libraryId } }">{{
        t('fanfiction.importInbox.title')
      }}</RouterLink></Button
    >
    <div
      v-if="!state.metadataReview.value"
      class="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <p role="status" class="text-sm text-muted-foreground">
        {{
          t(resolved ? 'fanfiction.attentionReview.resolved' : running ? 'fanfiction.attentionReview.running' : 'fanfiction.attentionReview.pending')
        }}
      </p>
      <Button class="min-h-11" :variant="resolved ? 'default' : 'outline'" :disabled="working" @click="next">{{
        t(resolved || running ? 'common.next' : 'fanfiction.reviewQueue.skip')
      }}</Button>
    </div>
  </div>
</template>

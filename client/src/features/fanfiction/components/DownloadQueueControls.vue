<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

const props = defineProps<{ libraryId: number; jobId: string; paused: boolean; queued: boolean; disabled?: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const busy = ref(false),
  failed = ref(false)
async function act(action: 'pause' | 'resume' | 'prioritize') {
  if (busy.value || props.disabled) return
  busy.value = true
  failed.value = false
  try {
    const response = await api(`/api/v1/libraries/${props.libraryId}/fanfiction/jobs/${props.jobId}/${action}`, {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) throw new Error()
    emit('changed')
  } catch {
    failed.value = true
  } finally {
    busy.value = false
  }
}
const pause = () => act('pause'),
  resume = () => act('resume'),
  prioritize = () => act('prioritize')
</script>
<template>
  <div class="flex flex-wrap items-center gap-2">
    <Button v-if="paused" variant="outline" :disabled="busy || disabled" @click="resume">{{ t('bookMetadataFetch.actions.resume') }}</Button>
    <template v-else
      ><Button variant="outline" :disabled="busy || disabled" @click="pause">{{ t('bookMetadataFetch.actions.pause') }}</Button>
      <Button v-if="queued" variant="outline" :disabled="busy || disabled" @click="prioritize">{{
        t('fanfiction.downloads.processNext')
      }}</Button></template
    >
    <span v-if="failed" role="alert" class="text-sm text-destructive">{{ t('fanfiction.downloads.actionError') }}</span>
  </div>
</template>

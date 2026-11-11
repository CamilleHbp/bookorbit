<script setup lang="ts">
import { computed, ref } from 'vue'
import { RotateCw } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { api } from '@/lib/api'
import type { FanfictionGroupRetryResult } from '@bookorbit/types'
const props = defineProps<{ url: string; body: { group: string } | { libraryId?: number }; subject: string }>()
const emit = defineEmits<{ retried: [] }>()
const { t } = useI18n()
const busy = ref(false)
const label = computed(() => t('fanfiction.bulk.retryFailed') + ' · ' + props.subject)
async function retry() {
  if (busy.value) return
  busy.value = true
  try {
    const res = await api(props.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(props.body) })
    if (!res.ok) throw new Error()
    const { queued, skipped } = (await res.json()) as FanfictionGroupRetryResult
    toast.success(t('fanfiction.downloads.retryResult', { queued, skipped }))
    emit('retried')
  } catch {
    toast.error(t('fanfiction.downloads.retryError'))
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <button
    type="button"
    :disabled="busy"
    :aria-busy="busy"
    :aria-label="label"
    :title="label"
    class="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-2 disabled:opacity-50"
    @click="retry"
  >
    <RotateCw class="size-4" :class="{ 'animate-spin': busy }" aria-hidden="true" />
  </button>
</template>

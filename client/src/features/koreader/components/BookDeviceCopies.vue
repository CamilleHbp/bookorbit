<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BookDetail } from '@bookorbit/types'
import KoreaderCopiesPanel from './KoreaderCopiesPanel.vue'

const props = defineProps<{ files: BookDetail['files'] }>()
const { t } = useI18n()
const open = ref(false)
const fileId = ref<number>()
const files = computed(() => props.files.filter((file) => ['epub', 'kepub'].includes(file.format ?? '')))
watch(
  files,
  (value) => {
    if (!value.some((file) => file.id === fileId.value)) fileId.value = value[0]?.id
  },
  { immediate: true },
)
function toggle(event: Event) {
  open.value = (event.target as HTMLDetailsElement).open
}
</script>

<template>
  <details v-if="files.length" class="rounded-lg border border-border p-4" @toggle="toggle">
    <summary class="cursor-pointer text-sm font-medium">{{ t('koreaderCopies.title') }}</summary>
    <div v-if="open && fileId" class="mt-4 space-y-4">
      <label v-if="files.length > 1" class="flex flex-wrap items-center gap-2 text-sm">
        {{ t('koreaderCopies.file') }}
        <select v-model="fileId" class="max-w-full rounded-md border border-input bg-background p-2">
          <option v-for="file in files" :key="file.id" :value="file.id">{{ file.filename }}</option>
        </select>
      </label>
      <KoreaderCopiesPanel :book-file-id="fileId" />
    </div>
  </details>
</template>

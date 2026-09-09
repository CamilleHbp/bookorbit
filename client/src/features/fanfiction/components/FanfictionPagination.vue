<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'

defineProps<{ page: number; previous: boolean; next: boolean; busy: boolean; label: string }>()
const emit = defineEmits<{ previous: []; next: [] }>()
const { t } = useI18n()
function handlePrevious() {
  emit('previous')
}
function handleNext() {
  emit('next')
}
</script>

<template>
  <nav v-if="previous || next" :aria-label="label" class="flex items-center justify-between gap-3 border-t border-border pt-4">
    <Button variant="outline" :disabled="busy || !previous" @click="handlePrevious">{{ t('common.previous') }}</Button>
    <span class="text-sm text-muted-foreground tabular-nums">{{ t('fanfiction.pageNumber', { page }) }}</span>
    <Button variant="outline" :disabled="busy || !next" @click="handleNext">{{ t('common.next') }}</Button>
  </nav>
</template>

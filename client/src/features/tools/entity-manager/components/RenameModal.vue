<script setup lang="ts">
import { ref, useId } from 'vue'
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle } from 'reka-ui'
import { useI18n } from 'vue-i18n'
import { X } from '@lucide/vue'

const { t } = useI18n()
const inputId = useId()

const props = defineProps<{
  currentName: string
  loading: boolean
  error?: string
  maxLength?: number
  fallbackFocus?: HTMLElement | null
}>()

const emit = defineEmits<{
  confirm: [newName: string, writeFiles: boolean]
  cancel: []
}>()

const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
const nameInput = ref<HTMLInputElement | null>(null)

function handleOpenAutoFocus(event: Event): void {
  event.preventDefault()
  nameInput.value?.focus()
  nameInput.value?.select()
}

function handleCloseAutoFocus(event: Event): void {
  event.preventDefault()
  const target = returnFocus?.isConnected ? returnFocus : props.fallbackFocus
  target?.focus()
}

const newName = ref(props.currentName)
const writeFiles = ref(false)

function handleConfirm(): void {
  const trimmed = newName.value.trim()
  if (!props.loading && trimmed && trimmed !== props.currentName) {
    emit('confirm', trimmed, writeFiles.value)
  }
}

function handleCancel(): void {
  if (!props.loading) emit('cancel')
}
function handleOpenChange(open: boolean): void {
  if (!open) handleCancel()
}
</script>

<template>
  <DialogRoot :open="true" @update:open="handleOpenChange">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-scrim" />
      <DialogContent
        :aria-describedby="undefined"
        @open-auto-focus="handleOpenAutoFocus"
        @close-auto-focus="handleCloseAutoFocus"
        class="fixed start-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-border bg-card text-foreground"
      >
        <div class="flex items-center justify-between px-5 py-4 border-b border-border">
          <DialogTitle class="text-base font-semibold">{{ t('tools.entityManager.renameModal.title') }}</DialogTitle>
          <button
            type="button"
            :aria-label="t('common.close')"
            :disabled="loading"
            class="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            @click="handleCancel"
          >
            <X class="h-5 w-5" />
          </button>
        </div>
        <div class="px-5 py-4 space-y-4">
          <div>
            <label class="text-sm text-muted-foreground block mb-1">{{ t('tools.entityManager.renameModal.currentName') }}</label>
            <p class="text-sm font-medium">{{ currentName }}</p>
          </div>
          <div>
            <label :for="inputId" class="text-sm text-muted-foreground block mb-1">{{ t('tools.entityManager.renameModal.newName') }}</label>
            <input
              ref="nameInput"
              :id="inputId"
              v-model="newName"
              :disabled="loading"
              :maxlength="maxLength"
              type="text"
              class="w-full h-9 px-3 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              @keydown.enter="handleConfirm"
            />
          </div>
          <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
          <label class="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <input v-model="writeFiles" type="checkbox" class="rounded accent-primary" />
            {{ t('tools.entityManager.writeChangesToFiles') }}
          </label>
        </div>
        <div class="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20">
          <button class="h-9 px-4 rounded-lg text-sm font-medium hover:bg-muted transition-colors" @click="handleCancel">
            {{ t('common.cancel') }}
          </button>
          <button
            class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none transition-colors"
            :disabled="loading || !newName.trim() || newName.trim() === currentName"
            @click="handleConfirm"
          >
            {{ t('tools.entityManager.actions.rename') }}
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

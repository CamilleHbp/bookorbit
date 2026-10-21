<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AudioLines, ChevronDown, Cpu, Loader2, TriangleAlert, X } from '@lucide/vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import {
  estimateReadAloudWorkBytes,
  Permission,
  type CreateReadAloudJobRequest,
  type ReadAloudCapability,
  type ReadAloudGranularity,
  type ReadAloudJobInput,
} from '@bookorbit/types'
import { formatBytes } from '@/lib/formatting'
import { formatLanguageName } from '@/i18n/formatters'
import { Select } from '@/components/ui/select'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { baseLanguage, deviceLabel, formatReadAloudDuration } from '../lib/read-aloud'
import ReadAloudTrackList from './ReadAloudTrackList.vue'

/** Display names for the model ids the server reports; an id this build does not know shows as sent. */
const MODEL_NAMES: Record<string, string> = { quartznet15x5: 'QuartzNet15x5' }

const props = defineProps<{
  open: boolean
  capability: ReadAloudCapability
  defaultLanguage: string | null
  /** A previous job's input, for "Start over"; null starts from the book's defaults. */
  initial: ReadAloudJobInput | null
  busy: boolean
  /** A translation key for the last failed start, owned by the dialog's caller. */
  error: string | null
}>()

const emit = defineEmits<{ close: []; create: [input: CreateReadAloudJobRequest] }>()

const { t, locale } = useI18n()
const { hasPermission } = usePermissions()
const ids = useId()
const trackListId = `${ids}-tracks`

const epubFileId = ref<number | null>(null)
const trackOrder = ref<number[]>([])
const skippedTracks = ref<number[]>([])
const orderOpen = ref(false)
const advancedOpen = ref(false)
const language = ref('')
const granularity = ref<ReadAloudGranularity>('sentence')
/** The read-along to overwrite, or "keep" to add the new one beside it. */
const existingChoice = ref<number | 'keep'>('keep')
/** Replacing deletes the old file, so the server only accepts it from someone who may delete books. */
const canReplace = computed(() => hasPermission(Permission.LibraryDeleteBooks))

const bookOrder = computed(() => props.capability.audioFiles.map((file) => file.id))
const skippedSet = computed(() => new Set(skippedTracks.value))
const includedTrackIds = computed(() => trackOrder.value.filter((id) => !skippedSet.value.has(id)))
const isBookOrder = computed(() => {
  const included = includedTrackIds.value
  const reference = bookOrder.value.filter((id) => !skippedSet.value.has(id))
  return included.length === reference.length && included.every((id, index) => id === reference[index])
})
const orderChanged = computed(() => !isBookOrder.value || skippedTracks.value.length > 0)

const includedDuration = computed(() => {
  const included = new Set(includedTrackIds.value)
  const durations = props.capability.audioFiles.filter((file) => included.has(file.id) && file.durationSeconds != null)
  if (durations.length === 0) return null
  return durations.reduce((total, file) => total + (file.durationSeconds ?? 0), 0)
})

const audioSummary = computed(() => {
  const values = { count: includedTrackIds.value.length, order: isBookOrder.value ? 'book' : 'custom' }
  if (includedDuration.value === null) return t('book.detail.files.readAloud.dialog.audioSummary', values)
  return t('book.detail.files.readAloud.dialog.audioSummaryWithDuration', {
    ...values,
    duration: formatReadAloudDuration(includedDuration.value, t),
  })
})

const existingReadAlongs = computed(() => props.capability.existingReadAlongs)
const modelName = computed(() => MODEL_NAMES[props.capability.model as string] ?? props.capability.model)
const showEpubChoice = computed(() => props.capability.epubFiles.length > 1)
const singleEpub = computed(() => (props.capability.epubFiles.length === 1 ? props.capability.epubFiles[0]! : null))

const languageOptions = computed(() =>
  props.capability.supportedLanguages
    .map((code) => ({ code, name: formatLanguageName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale.value)),
)

/** Say why the book's own language was not picked, rather than leaving an unexplained empty select. */
const unsupportedLanguageHint = computed(() => {
  if (language.value) return null
  const base = baseLanguage(props.defaultLanguage)
  if (!base || isSupportedLanguage(base)) return null
  return t('book.detail.files.readAloud.dialog.languageUnsupported', { language: formatLanguageName(base) })
})

const deviceLine = computed(() => deviceLabel(props.capability.workerDevice, t))
const estimatedSize = computed(() =>
  props.capability.estimatedOutputBytes != null
    ? t('book.detail.files.readAloud.dialog.estimatedSize', { size: formatBytes(props.capability.estimatedOutputBytes) })
    : null,
)

/** Working space the worker needs for this selection; a shortfall is worth saying before hours of work. */
const lowDiskWarning = computed(() => {
  const free = props.capability.workerFreeBytes
  if (free == null) return null
  const included = new Set(includedTrackIds.value)
  const audio = props.capability.audioFiles.filter((file) => included.has(file.id))
  const needed = estimateReadAloudWorkBytes({
    audioBytes: audio.reduce((total, file) => total + (file.sizeBytes ?? 0), 0),
    epubBytes: props.capability.epubFiles.find((file) => file.id === epubFileId.value)?.sizeBytes ?? 0,
    audioDurationSeconds: audio.every((file) => file.durationSeconds != null) ? includedDuration.value : null,
  })
  if (needed <= free) return null
  return t('book.detail.files.readAloud.dialog.lowDisk', { needed: formatBytes(needed), free: formatBytes(free) })
})

const canSubmit = computed(() => epubFileId.value !== null && includedTrackIds.value.length > 0 && language.value.length > 0 && !props.busy)

function isSupportedLanguage(code: string): boolean {
  return (props.capability.supportedLanguages as readonly string[]).includes(code)
}

/** BookOrbit's own output is safe to overwrite; an imported one may be the only copy of someone's work. */
function defaultExistingChoice(): number | 'keep' {
  if (!canReplace.value) return 'keep'
  const generated = props.capability.existingReadAlongs.find((file) => file.generatedByJobId !== null)
  return generated ? generated.fileId : 'keep'
}

function initialise(): void {
  const capability = props.capability
  const initial = props.initial
  const epubIds = capability.epubFiles.map((file) => file.id)
  epubFileId.value = initial && epubIds.includes(initial.epubFileId) ? initial.epubFileId : (epubIds[0] ?? null)

  const available = bookOrder.value
  if (initial) {
    const availableSet = new Set(available)
    const chosen = initial.audioFileIds.filter((id) => availableSet.has(id))
    const chosenSet = new Set(chosen)
    const rest = available.filter((id) => !chosenSet.has(id))
    trackOrder.value = [...chosen, ...rest]
    skippedTracks.value = chosen.length > 0 ? rest : []
  } else {
    trackOrder.value = [...available]
    skippedTracks.value = []
  }
  orderOpen.value = false

  const preferred = initial?.language ?? baseLanguage(props.defaultLanguage)
  language.value = preferred && isSupportedLanguage(preferred) ? preferred : ''
  granularity.value = initial?.granularity ?? 'sentence'
  advancedOpen.value = granularity.value !== 'sentence'

  const existingIds = capability.existingReadAlongs.map((file) => file.fileId)
  existingChoice.value =
    canReplace.value && initial?.replaceFileId != null && existingIds.includes(initial.replaceFileId)
      ? initial.replaceFileId
      : defaultExistingChoice()
}

/** Files can come and go while the dialog is open; keep what still exists and add what is new. */
function reconcileWithCapability(): void {
  const capability = props.capability
  const epubIds = capability.epubFiles.map((file) => file.id)
  if (epubFileId.value === null || !epubIds.includes(epubFileId.value)) epubFileId.value = epubIds[0] ?? null

  const available = new Set(bookOrder.value)
  const kept = trackOrder.value.filter((id) => available.has(id))
  const keptSet = new Set(kept)
  trackOrder.value = [...kept, ...bookOrder.value.filter((id) => !keptSet.has(id))]
  skippedTracks.value = skippedTracks.value.filter((id) => available.has(id))

  const choice = existingChoice.value
  if (choice !== 'keep' && (!canReplace.value || !capability.existingReadAlongs.some((file) => file.fileId === choice))) {
    existingChoice.value = defaultExistingChoice()
  }
  if (language.value && !isSupportedLanguage(language.value)) language.value = ''
}

/**
 * The dialog opens from more than one place (the toolbar, "Start over" on a job card) and has no
 * trigger of its own, so reka has nothing to return focus to. Remember what had it instead.
 */
let returnFocusTo: HTMLElement | null = null

watch(
  () => props.open,
  (open) => {
    if (!open) return
    returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    initialise()
  },
  { immediate: true },
)

function handleCloseAutoFocus(event: Event): void {
  const target = returnFocusTo
  returnFocusTo = null
  if (!target?.isConnected) return
  event.preventDefault()
  target.focus()
}

watch(
  () => props.capability,
  () => {
    if (props.open) reconcileWithCapability()
  },
)

function handleOpenChange(open: boolean): void {
  if (!open && !props.busy) emit('close')
}

function handleClose(): void {
  if (!props.busy) emit('close')
}

function handleToggleOrder(): void {
  orderOpen.value = !orderOpen.value
}

function handleRestoreOrder(): void {
  trackOrder.value = [...bookOrder.value]
  skippedTracks.value = []
}

function handleToggleAdvanced(): void {
  advancedOpen.value = !advancedOpen.value
}

function existingOrigin(generatedByJobId: string | null): string {
  return generatedByJobId ? t('book.detail.files.readAloud.dialog.existing.generated') : t('book.detail.files.readAloud.dialog.existing.imported')
}

function handleSubmit(): void {
  if (!canSubmit.value || epubFileId.value === null) return
  const input: CreateReadAloudJobRequest = {
    epubFileId: epubFileId.value,
    audioFileIds: includedTrackIds.value,
    language: language.value,
    granularity: granularity.value,
  }
  if (canReplace.value && existingChoice.value !== 'keep') input.replaceFileId = existingChoice.value
  emit('create', input)
}
</script>

<template>
  <DialogRoot :open="open" @update:open="handleOpenChange">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-[70] bg-scrim" />
      <DialogContent
        @close-auto-focus="handleCloseAutoFocus"
        class="fixed inset-x-0 bottom-0 z-[70] flex max-h-[92dvh] flex-col rounded-t-2xl border border-border bg-card shadow-xl focus-visible:outline-none sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[min(40rem,calc(100%-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
      >
        <header class="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4 sm:px-6">
          <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <AudioLines class="size-[18px]" aria-hidden="true" />
          </span>
          <div class="min-w-0 flex-1">
            <DialogTitle class="text-base font-semibold text-foreground">{{ t('book.detail.files.readAloud.dialog.title') }}</DialogTitle>
            <DialogDescription class="mt-1 text-sm text-muted-foreground">
              {{ t('book.detail.files.readAloud.dialog.description') }}
            </DialogDescription>
          </div>
          <button
            type="button"
            class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="t('common.close')"
            :disabled="busy"
            @click="handleClose"
          >
            <X class="size-4" aria-hidden="true" />
          </button>
        </header>

        <div class="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 sm:px-6">
          <!-- Ebook -->
          <fieldset v-if="showEpubChoice">
            <legend class="text-sm font-semibold text-foreground">{{ t('book.detail.files.readAloud.dialog.ebook') }}</legend>
            <p class="mt-1 text-xs text-muted-foreground">{{ t('book.detail.files.readAloud.dialog.ebookHint') }}</p>
            <div class="mt-2.5 grid gap-1.5">
              <label
                v-for="file in capability.epubFiles"
                :key="file.id"
                class="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors"
                :class="epubFileId === file.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'"
              >
                <input
                  v-model="epubFileId"
                  type="radio"
                  :name="`${ids}-epub`"
                  :value="file.id"
                  class="size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <span class="min-w-0 flex-1 truncate text-sm text-foreground" :title="file.filename">{{ file.filename }}</span>
                <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{{ formatBytes(file.sizeBytes) }}</span>
              </label>
            </div>
          </fieldset>
          <div v-else-if="singleEpub">
            <h3 class="text-sm font-semibold text-foreground">{{ t('book.detail.files.readAloud.dialog.ebook') }}</h3>
            <p class="mt-1 flex items-center gap-2 text-sm text-foreground">
              <span class="min-w-0 truncate" :title="singleEpub.filename">{{ singleEpub.filename }}</span>
              <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{{ formatBytes(singleEpub.sizeBytes) }}</span>
            </p>
          </div>

          <!-- Existing read-alongs -->
          <fieldset v-if="existingReadAlongs.length > 0 && canReplace" class="rounded-lg border border-border bg-muted/40 p-3.5">
            <legend class="sr-only">
              {{ t('book.detail.files.readAloud.dialog.existing.title', { count: existingReadAlongs.length }) }}
            </legend>
            <p class="text-sm font-semibold text-foreground" aria-hidden="true">
              {{ t('book.detail.files.readAloud.dialog.existing.title', { count: existingReadAlongs.length }) }}
            </p>
            <div class="mt-2.5 grid gap-1.5">
              <label v-for="file in existingReadAlongs" :key="file.fileId" class="flex cursor-pointer items-start gap-3 rounded-md px-1 py-1">
                <input
                  v-model="existingChoice"
                  type="radio"
                  :name="`${ids}-existing`"
                  :value="file.fileId"
                  class="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <span class="min-w-0 flex-1">
                  <span class="block break-words text-sm text-foreground">
                    {{ t('book.detail.files.readAloud.dialog.existing.replace', { filename: file.filename }) }}
                  </span>
                  <span class="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground">
                    <span>{{ existingOrigin(file.generatedByJobId) }}</span>
                    <template v-if="file.sizeBytes != null">
                      <span aria-hidden="true">·</span>
                      <span class="tabular-nums">{{ formatBytes(file.sizeBytes) }}</span>
                    </template>
                  </span>
                </span>
              </label>
              <label class="flex cursor-pointer items-start gap-3 rounded-md px-1 py-1">
                <input
                  v-model="existingChoice"
                  type="radio"
                  :name="`${ids}-existing`"
                  value="keep"
                  class="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <span class="min-w-0 flex-1">
                  <span class="block text-sm text-foreground">
                    {{ t('book.detail.files.readAloud.dialog.existing.keep', { count: existingReadAlongs.length }) }}
                  </span>
                  <span class="mt-0.5 block text-xs text-muted-foreground">{{ t('book.detail.files.readAloud.dialog.existing.keepHint') }}</span>
                </span>
              </label>
            </div>
            <p v-if="existingChoice !== 'keep'" class="mt-2 text-xs text-muted-foreground">
              {{ t('book.detail.files.readAloud.dialog.existing.replaceHint') }}
            </p>
          </fieldset>
          <section
            v-else-if="existingReadAlongs.length > 0"
            class="rounded-lg border border-border bg-muted/40 p-3.5"
            :aria-labelledby="`${ids}-existing`"
            data-test="read-aloud-existing"
          >
            <h3 :id="`${ids}-existing`" class="text-sm font-semibold text-foreground">
              {{ t('book.detail.files.readAloud.dialog.existing.title', { count: existingReadAlongs.length }) }}
            </h3>
            <ul class="mt-2 grid gap-1.5">
              <li v-for="file in existingReadAlongs" :key="file.fileId" class="min-w-0">
                <span class="block break-words text-sm text-foreground">{{ file.filename }}</span>
                <span class="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground">
                  <span>{{ existingOrigin(file.generatedByJobId) }}</span>
                  <template v-if="file.sizeBytes != null">
                    <span aria-hidden="true">·</span>
                    <span class="tabular-nums">{{ formatBytes(file.sizeBytes) }}</span>
                  </template>
                </span>
              </li>
            </ul>
            <p class="mt-2 text-xs text-muted-foreground">{{ t('book.detail.files.readAloud.dialog.existing.replaceNotPermitted') }}</p>
          </section>

          <!-- Audiobook -->
          <section :aria-labelledby="`${ids}-audio`">
            <h3 :id="`${ids}-audio`" class="text-sm font-semibold text-foreground">{{ t('book.detail.files.readAloud.dialog.audio') }}</h3>
            <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <p class="text-sm text-foreground">{{ audioSummary }}</p>
              <p v-if="skippedTracks.length > 0" class="text-xs text-muted-foreground">
                {{ t('book.detail.files.readAloud.dialog.audioSkipped', { count: skippedTracks.length }) }}
              </p>
              <button
                v-if="capability.audioFiles.length > 1"
                type="button"
                class="-mx-1 inline-flex min-h-7 items-center gap-1 rounded px-1 text-[13px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :aria-expanded="orderOpen"
                :aria-controls="trackListId"
                @click="handleToggleOrder"
              >
                {{ t('book.detail.files.readAloud.dialog.changeOrder') }}
                <ChevronDown
                  class="size-3.5 transition-transform motion-reduce:transition-none"
                  :class="orderOpen ? 'rotate-180' : ''"
                  aria-hidden="true"
                />
              </button>
            </div>
            <div v-show="orderOpen" :id="trackListId" class="mt-2.5">
              <ReadAloudTrackList v-model:order="trackOrder" v-model:skipped="skippedTracks" :tracks="capability.audioFiles" />
              <button
                v-if="orderChanged"
                type="button"
                class="-mx-1 mt-1.5 inline-flex min-h-7 items-center rounded px-1 text-[13px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="handleRestoreOrder"
              >
                {{ t('book.detail.files.readAloud.dialog.restoreOrder') }}
              </button>
            </div>
            <p v-if="includedTrackIds.length === 0" role="alert" class="mt-1.5 text-xs text-destructive">
              {{ t('book.detail.files.readAloud.dialog.noTracks') }}
            </p>
          </section>

          <!-- Language -->
          <div>
            <label :for="`${ids}-language`" class="text-sm font-semibold text-foreground">{{
              t('book.detail.files.readAloud.dialog.language')
            }}</label>
            <Select
              :id="`${ids}-language`"
              v-model="language"
              class="mt-2 sm:max-w-xs"
              :aria-describedby="unsupportedLanguageHint ? `${ids}-language-hint` : undefined"
            >
              <option value="" disabled>{{ t('book.detail.files.readAloud.dialog.chooseLanguage') }}</option>
              <option v-for="option in languageOptions" :key="option.code" :value="option.code">{{ option.name }}</option>
            </Select>
            <p v-if="unsupportedLanguageHint" :id="`${ids}-language-hint`" class="mt-1.5 text-xs text-muted-foreground">
              {{ unsupportedLanguageHint }}
            </p>
          </div>

          <!-- Advanced -->
          <div>
            <button
              type="button"
              class="-mx-1 inline-flex min-h-7 items-center gap-1 rounded px-1 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :aria-expanded="advancedOpen"
              :aria-controls="`${ids}-advanced`"
              @click="handleToggleAdvanced"
            >
              <ChevronDown
                class="size-4 transition-transform motion-reduce:transition-none"
                :class="advancedOpen ? '' : '-rotate-90 rtl:rotate-90'"
                aria-hidden="true"
              />
              {{ t('book.detail.files.readAloud.dialog.advanced') }}
            </button>
            <fieldset v-show="advancedOpen" :id="`${ids}-advanced`" class="mt-2.5">
              <legend class="text-sm font-medium text-foreground">{{ t('book.detail.files.readAloud.dialog.granularity') }}</legend>
              <div class="mt-2 grid gap-1.5">
                <label class="flex cursor-pointer items-start gap-3 rounded-md px-1 py-1">
                  <input
                    v-model="granularity"
                    type="radio"
                    :name="`${ids}-granularity`"
                    value="sentence"
                    class="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm text-foreground">{{ t('book.detail.files.readAloud.dialog.sentence') }}</span>
                    <span class="mt-0.5 block text-xs text-muted-foreground">{{ t('book.detail.files.readAloud.dialog.sentenceHint') }}</span>
                  </span>
                </label>
                <label class="flex cursor-pointer items-start gap-3 rounded-md px-1 py-1">
                  <input
                    v-model="granularity"
                    type="radio"
                    :name="`${ids}-granularity`"
                    value="word"
                    class="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
                      {{ t('book.detail.files.readAloud.dialog.word') }}
                      <span
                        class="inline-flex h-[18px] items-center rounded bg-warning/15 px-1.5 text-[10.5px] font-bold uppercase tracking-wider text-foreground"
                      >
                        {{ t('book.detail.files.readAloud.dialog.experimental') }}
                      </span>
                    </span>
                    <span class="mt-0.5 block text-xs text-muted-foreground">{{ t('book.detail.files.readAloud.dialog.wordHint') }}</span>
                  </span>
                </label>
              </div>
            </fieldset>
          </div>

          <!-- What runs it -->
          <div class="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3.5">
            <Cpu class="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <div class="min-w-0 flex-1 text-xs text-muted-foreground">
              <p class="text-sm font-medium text-foreground">{{ t('book.detail.files.readAloud.dialog.model', { model: modelName }) }}</p>
              <p v-if="deviceLine || estimatedSize" class="mt-0.5 flex flex-wrap gap-x-3">
                <span v-if="deviceLine">{{ deviceLine }}</span>
                <span v-if="estimatedSize" class="tabular-nums">{{ estimatedSize }}</span>
              </p>
              <p class="mt-1.5">{{ t('book.detail.files.readAloud.dialog.processingNote') }}</p>
            </div>
          </div>

          <p v-if="lowDiskWarning" class="flex items-start gap-2 text-xs text-muted-foreground">
            <TriangleAlert class="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span
              ><span class="font-semibold text-foreground">{{ t('book.detail.files.readAloud.dialog.lowDiskLabel') }}</span>
              {{ lowDiskWarning }}</span
            >
          </p>

          <p v-if="error" role="alert" class="text-sm text-destructive">{{ t(error) }}</p>
        </div>

        <footer
          class="flex shrink-0 flex-col-reverse gap-2 border-t border-border px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:flex-row sm:justify-end sm:px-6 sm:pb-4"
        >
          <button
            type="button"
            class="inline-flex h-10 items-center justify-center rounded-lg border border-input px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            :disabled="busy"
            @click="handleClose"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            :disabled="!canSubmit"
            @click="handleSubmit"
          >
            <Loader2 v-if="busy" class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {{ busy ? t('book.detail.files.readAloud.dialog.starting') : t('book.detail.files.readAloud.dialog.start') }}
          </button>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

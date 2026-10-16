<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Info, Search, TextCursorInput, Type, Upload, X } from '@lucide/vue'
import { MAX_SERVER_FONTS } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { formatNumber } from '@/i18n/formatters'
import { formatBytes } from '@/lib/formatting'
import SettingsPageHeader from './SettingsPageHeader.vue'
import FontDropOverlay from './server-fonts/components/FontDropOverlay.vue'
import FontUploadTray from './server-fonts/components/FontUploadTray.vue'
import ServerFontFamilySheet from './server-fonts/components/ServerFontFamilySheet.vue'
import ServerFontRow from './server-fonts/components/ServerFontRow.vue'
import { useFailedFontFaces } from './server-fonts/composables/useFailedFontFaces'
import { useServerFontLibrary } from './server-fonts/composables/useServerFontLibrary'

withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const HEADER_ACTIONS_TARGET = '#settings-header-actions'
const PREVIEW_SIZES = [18, 24, 32] as const
const ACCEPT = '.ttf,.otf,.woff,.woff2'

const { t, locale } = useI18n()
const { isDemoRestrictedAccount: readonly } = usePermissions()
const library = useServerFontLibrary()
const { store, uploads, newFamilies } = library
const { failed: failedFaces } = useFailedFontFaces()

/**
 * The header renders the primary action beside the title. Falling back to rendering in place keeps
 * it reachable when this page is mounted outside the settings shell, including in tests.
 */
const headerSlotAvailable = ref(false)

const query = ref('')
const previewText = ref('')
const previewSize = ref<number>(PREVIEW_SIZES[1])
const sample = computed(() => previewText.value.trim() || t('settings.reader.fonts.pangram'))

const collator = computed(() => new Intl.Collator(locale.value, { sensitivity: 'base', numeric: true }))
const families = computed(() => [...store.families.value].sort((a, b) => collator.value.compare(a.name, b.name)))
const visibleFamilies = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase(locale.value)
  return needle ? families.value.filter((family) => family.name.toLocaleLowerCase(locale.value).includes(needle)) : families.value
})
const totalBytes = computed(() => store.fonts.value.reduce((sum, font) => sum + font.fileSize, 0))
const hasFonts = computed(() => store.fonts.value.length > 0)
/** A refetch keeps the rows on screen; only a first load with nothing to show yet says so. */
const firstLoad = computed(() => store.loading.value && !hasFonts.value)

// ── Family sheet ───────────────────────────────────────────
const openFamilyName = ref<string | null>(null)
const armRemove = ref(false)
const focusName = ref(false)
const sheetBusy = ref(false)
const openFamily = computed(() => families.value.find((family) => family.name === openFamilyName.value) ?? null)
const openUsage = computed(() => library.usageOf(openFamilyName.value ?? ''))

function openSheet(name: string, options: { remove?: boolean; rename?: boolean } = {}) {
  armRemove.value = options.remove ?? false
  focusName.value = options.rename ?? false
  openFamilyName.value = name
}
function handleOpen(name: string) {
  openSheet(name)
}
function handleRename(name: string) {
  openSheet(name, { rename: true })
}
function handleRemoveRequest(name: string) {
  openSheet(name, { remove: true })
}
function closeSheet() {
  openFamilyName.value = null
  armRemove.value = false
  focusName.value = false
}

async function saveRename(newName: string) {
  const name = openFamilyName.value
  if (!name) return
  sheetBusy.value = true
  const result = await library.renameFamily(name, newName)
  sheetBusy.value = false
  if (result.ok) {
    toast.success(t('settings.reader.fonts.renamedTo', { name: newName }))
    closeSheet()
  } else if (result.code === 'FONT_FACE_TAKEN') {
    toast.error(t('settings.admin.serverFonts.toasts.renameTaken', { name: newName }))
  } else {
    toast.error(t('settings.reader.fonts.renameFamilyFailed'))
  }
}

async function removeOpenFamily() {
  const name = openFamilyName.value
  if (!name) return
  sheetBusy.value = true
  const { failed } = await library.removeFamily(name)
  sheetBusy.value = false
  if (failed === 0) {
    toast.success(t('settings.admin.serverFonts.toasts.removed', { name }))
    closeSheet()
  } else {
    toast.error(t('settings.admin.serverFonts.toasts.removePartial', { failed, name }))
  }
}

async function updateFile(fontId: number, data: { weight: number; style: 'normal' | 'italic' }) {
  if (!(await library.updateFile(fontId, data))) toast.error(t('settings.reader.fonts.updateVariantFailed'))
}

async function removeFile(fontId: number) {
  const ok = await store.deleteFont(fontId).catch(() => false)
  if (!ok) {
    toast.error(t('settings.reader.fonts.deleteFontFailed'))
    return
  }
  if (!openFamily.value) closeSheet()
  await library.fetchUsage()
}

// ── Uploads ────────────────────────────────────────────────
const fileInput = ref<HTMLInputElement | null>(null)

function openFilePicker() {
  if (readonly.value) {
    toast.error(t('settings.reader.fonts.demoCannotManage'))
    return
  }
  fileInput.value?.click()
}

function handleFileInput(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  void library.addFiles(files)
}

function dismissUploads() {
  library.dismissUploads()
}

// The whole page is the drop target, since the button that opens a picker is far from most rows.
const dragCount = ref<number | null>(null)
let dragDepth = 0

function carriesFiles(event: DragEvent): boolean {
  return !readonly.value && (event.dataTransfer?.types ?? []).includes('Files')
}
function handleDragEnter(event: DragEvent) {
  if (!carriesFiles(event)) return
  event.preventDefault()
  dragDepth++
  dragCount.value = event.dataTransfer?.items.length ?? 0
}
function handleDragOver(event: DragEvent) {
  if (!carriesFiles(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}
function handleDragLeave(event: DragEvent) {
  if (!carriesFiles(event)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragCount.value = null
}
function handleDrop(event: DragEvent) {
  if (!carriesFiles(event)) return
  event.preventDefault()
  dragDepth = 0
  dragCount.value = null
  void library.addFiles(Array.from(event.dataTransfer?.files ?? []))
}

// ── Toolbar ────────────────────────────────────────────────
function handleQueryInput(event: Event) {
  query.value = (event.target as HTMLInputElement).value
}
function clearQuery() {
  query.value = ''
}
function handlePreviewInput(event: Event) {
  previewText.value = (event.target as HTMLInputElement).value
}
function selectSize(size: number) {
  previewSize.value = size
}

// ── Font faces ─────────────────────────────────────────────
// The collection is not part of the app's own CSS, so its @font-face rules are injected for the
// names and specimens on this page to render in their own faces.
let fontFaceStyle: HTMLStyleElement | null = null

watch(
  () => store.fonts.value,
  () => {
    const css = store.generateFontFaceCSS()
    if (!fontFaceStyle) {
      if (!css) return
      fontFaceStyle = document.createElement('style')
      fontFaceStyle.setAttribute('data-server-fonts-page', '')
      document.head.appendChild(fontFaceStyle)
    }
    fontFaceStyle.textContent = css
  },
  { immediate: true },
)

onMounted(() => {
  headerSlotAvailable.value = document.getElementById(HEADER_ACTIONS_TARGET.slice(1)) !== null
  window.addEventListener('dragenter', handleDragEnter)
  window.addEventListener('dragover', handleDragOver)
  window.addEventListener('dragleave', handleDragLeave)
  window.addEventListener('drop', handleDrop)
  void library.load()
})

onUnmounted(() => {
  window.removeEventListener('dragenter', handleDragEnter)
  window.removeEventListener('dragover', handleDragOver)
  window.removeEventListener('dragleave', handleDragLeave)
  window.removeEventListener('drop', handleDrop)
  fontFaceStyle?.remove()
  fontFaceStyle = null
})
</script>

<template>
  <div class="@container flex flex-col gap-3">
    <SettingsPageHeader v-if="!embedded" :title="t('settings.admin.serverFonts.title')" :subtitle="t('settings.admin.serverFonts.subtitle')" />

    <Teleport :to="HEADER_ACTIONS_TARGET" defer :disabled="!headerSlotAvailable">
      <Button
        v-if="!readonly && hasFonts"
        size="sm"
        type="button"
        class="max-sm:size-8 max-sm:p-0"
        :aria-label="t('settings.admin.serverFonts.addFonts')"
        @click="openFilePicker"
      >
        <Upload :size="14" aria-hidden="true" />
        <span class="max-sm:sr-only">{{ t('settings.admin.serverFonts.addFonts') }}</span>
      </Button>
    </Teleport>

    <input
      ref="fileInput"
      type="file"
      :accept="ACCEPT"
      multiple
      class="sr-only"
      tabindex="-1"
      aria-hidden="true"
      data-testid="font-file-input"
      @change="handleFileInput"
    />

    <FontUploadTray v-if="uploads.length > 0" :entries="uploads" @dismiss="dismissUploads" />

    <div
      v-if="firstLoad"
      class="flex items-center justify-center rounded-xl border border-border bg-card py-10 text-sm text-muted-foreground shadow-xs"
      data-testid="font-loading-surface"
    >
      {{ t('common.loading') }}
    </div>

    <div
      v-else-if="!hasFonts"
      class="mx-auto mt-6 flex w-full max-w-[40rem] flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center shadow-xs"
      data-testid="font-empty-surface"
    >
      <div class="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
        <Type :size="22" aria-hidden="true" />
      </div>
      <div>
        <p class="text-sm font-medium text-foreground">{{ t('settings.admin.serverFonts.noFontsYet') }}</p>
        <p class="mt-1 text-xs text-muted-foreground">{{ t('settings.admin.serverFonts.noFontsHint') }}</p>
      </div>
      <template v-if="!readonly">
        <Button size="sm" type="button" @click="openFilePicker">
          <Upload :size="14" aria-hidden="true" />
          {{ t('settings.admin.serverFonts.addFonts') }}
        </Button>
        <p class="text-xs text-muted-foreground">
          {{ t('settings.admin.serverFonts.empty.dropHint') }} · {{ t('settings.reader.fonts.fileTypesHint') }}
        </p>
      </template>
      <p
        class="mt-2 flex max-w-md items-start gap-2 rounded-lg bg-muted/60 px-3 py-2.5 text-start text-[12.5px] leading-[18px] text-muted-foreground"
      >
        <Info :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />
        {{ t('settings.admin.serverFonts.empty.tip') }}
      </p>
    </div>

    <template v-else>
      <div class="flex flex-wrap items-center gap-2.5">
        <label class="relative block w-full min-w-0 @min-[48rem]:w-60">
          <span class="sr-only">{{ t('settings.admin.serverFonts.filterLabel') }}</span>
          <Search :size="15" class="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            class="input-field h-9 w-full ps-9 pe-9"
            :value="query"
            :placeholder="t('settings.admin.serverFonts.filterPlaceholder')"
            @input="handleQueryInput"
          />
          <button
            v-if="query"
            type="button"
            class="absolute end-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="t('settings.admin.serverFonts.filterClear')"
            @click="clearQuery"
          >
            <X :size="14" aria-hidden="true" />
          </button>
        </label>
        <label class="relative block min-w-0 flex-1 @min-[48rem]:max-w-[22.5rem]">
          <span class="sr-only">{{ t('settings.admin.serverFonts.previewLabel') }}</span>
          <TextCursorInput
            :size="15"
            class="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="text"
            class="input-field h-9 w-full ps-9"
            :value="previewText"
            :placeholder="t('settings.admin.serverFonts.previewPlaceholder')"
            @input="handlePreviewInput"
          />
        </label>
        <div
          role="group"
          :aria-label="t('settings.admin.serverFonts.previewSize')"
          class="flex shrink-0 gap-0.5 rounded-lg border border-border bg-muted p-0.5"
        >
          <button
            v-for="(size, index) in PREVIEW_SIZES"
            :key="size"
            type="button"
            class="grid h-[30px] w-[30px] place-items-center rounded-md font-serif leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :class="previewSize === size ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'"
            :style="{ fontSize: `${11 + index * 3}px` }"
            :aria-pressed="previewSize === size"
            :aria-label="t('settings.admin.serverFonts.previewSizeOption', { size })"
            :title="t('settings.admin.serverFonts.previewSizeOption', { size })"
            @click="selectSize(size)"
          >
            A
          </button>
        </div>
        <p
          data-testid="server-fonts-totals"
          class="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px] text-muted-foreground @min-[60rem]:ms-auto @min-[60rem]:w-auto"
        >
          <span
            ><span class="font-semibold text-foreground tabular-nums">{{ formatNumber(families.length) }}</span>
            {{ t('settings.admin.serverFonts.familiesUnit', { count: families.length }) }}</span
          >
          <span class="opacity-50" aria-hidden="true">&middot;</span>
          <i18n-t keypath="settings.admin.serverFonts.filesOfMax" tag="span" scope="global">
            <template #count
              ><span class="font-semibold text-foreground tabular-nums">{{ formatNumber(store.fonts.value.length) }}</span></template
            >
            <template #max>{{ formatNumber(MAX_SERVER_FONTS) }}</template>
          </i18n-t>
          <span class="opacity-50" aria-hidden="true">&middot;</span>
          <i18n-t keypath="settings.admin.serverFonts.onDisk" tag="span" scope="global">
            <template #size
              ><span class="font-semibold text-foreground tabular-nums">{{ formatBytes(totalBytes) }}</span></template
            >
          </i18n-t>
        </p>
      </div>

      <div
        aria-hidden="true"
        class="hidden grid-cols-[15.75rem_minmax(0,1fr)_11rem_9.5rem_2rem] gap-7 ps-[25px] pe-[21px] pt-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase @min-[60rem]:grid"
      >
        <span>{{ t('settings.admin.serverFonts.columns.family') }}</span>
        <span>{{ t('settings.admin.serverFonts.columns.specimen') }}</span>
        <span>{{ t('settings.admin.serverFonts.columns.styles') }}</span>
        <span>{{ t('settings.admin.serverFonts.columns.readers') }}</span>
      </div>

      <div v-if="visibleFamilies.length > 0" class="flex flex-col gap-2" data-testid="font-list-surface">
        <ServerFontRow
          v-for="family in visibleFamilies"
          :key="family.cssFamilyName"
          :family="family"
          :usage="library.usageOf(family.name)"
          :preview-text="sample"
          :preview-size="previewSize"
          :is-new="newFamilies.has(family.name)"
          :readonly="readonly"
          :load-failed="failedFaces.has(family.cssFamilyName)"
          @open="handleOpen"
          @rename="handleRename"
          @add-files="openFilePicker"
          @remove="handleRemoveRequest"
        />
      </div>
      <p v-else class="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        {{ t('settings.admin.serverFonts.noMatches', { query: query.trim() }) }}
      </p>

      <p class="px-1 pt-1 text-xs text-muted-foreground">{{ t('settings.admin.serverFonts.footerHint') }}</p>
    </template>

    <FontDropOverlay v-if="dragCount !== null" :count="dragCount" />

    <ServerFontFamilySheet
      :open="openFamily !== null"
      :family="openFamily"
      :usage="openUsage"
      :picker-families="families"
      :total-files="store.fonts.value.length"
      :max-files="MAX_SERVER_FONTS"
      :readonly="readonly"
      :busy="sheetBusy"
      :arm-remove="armRemove"
      :focus-name="focusName"
      :load-failed="openFamily !== null && failedFaces.has(openFamily.cssFamilyName)"
      @close="closeSheet"
      @save="saveRename"
      @remove="removeOpenFamily"
      @add-files="openFilePicker"
      @update-file="updateFile"
      @remove-file="removeFile"
    />
  </div>
</template>

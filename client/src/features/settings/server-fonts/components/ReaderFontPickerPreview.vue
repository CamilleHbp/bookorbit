<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FontFamily } from '@/features/reader/epub/composables/useCustomFonts'
import { BUILTIN_READER_FONT_OPTIONS } from '@/features/reader/shared/constants/font-options'
import { formatFontFamilyLabel } from '@/features/reader/shared/lib/font-display'
import { closestVariant, familyVariants, fontVariantLabel, isSameVariant } from '@/features/reader/shared/lib/font-variants'

/**
 * The Font section of the reader's settings panel, drawn with this server's families and one of them
 * chosen, so an administrator sees exactly what readers will be offered. It mirrors
 * ReaderSettingsPanel's markup and is display-only.
 */
const props = defineProps<{
  families: FontFamily[]
  selected: FontFamily | null
}>()

const { t } = useI18n()

const chips = computed(() => (props.selected ? familyVariants(props.selected.variants) : []))
/** A reader arriving with default settings lands on the style nearest Regular, as the reader picks it. */
const chosenChip = computed(() => closestVariant(chips.value, { weight: 400, style: 'normal' }))

const groupLabel = 'mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground'
const tile = 'flex h-10 items-center truncate rounded-lg border px-2 text-sm'
</script>

<template>
  <div class="rounded-xl border border-border bg-card px-4 py-3.5" role="group" :aria-label="t('settings.admin.serverFonts.sheet.pickerLabel')">
    <p class="mb-2 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{{ t('reader.settings.font') }}</p>
    <p :class="groupLabel">{{ t('reader.settings.fontBuiltIn') }}</p>
    <div class="grid grid-cols-2 gap-2">
      <span
        v-for="font in BUILTIN_READER_FONT_OPTIONS"
        :key="String(font.value)"
        :class="tile"
        class="border-border text-foreground"
        :style="font.value ? { fontFamily: font.value } : {}"
        >{{ t(font.labelKey) }}</span
      >
    </div>

    <template v-if="families.length > 0">
      <p :class="groupLabel" class="mt-3">{{ t('reader.settings.fontServer') }}</p>
      <div class="grid grid-cols-2 gap-2">
        <span
          v-for="family in families"
          :key="family.cssFamilyName"
          :class="[
            tile,
            family.cssFamilyName === selected?.cssFamilyName ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-foreground',
          ]"
          :style="{ fontFamily: `'${family.cssFamilyName}', sans-serif` }"
          >{{ formatFontFamilyLabel(family.name) }}</span
        >
      </div>
    </template>

    <template v-if="selected && chips.length > 1">
      <p :class="groupLabel" class="mt-3">{{ t('reader.settings.fontStyle') }}</p>
      <div class="flex flex-wrap gap-2">
        <span
          v-for="variant in chips"
          :key="`${variant.weight}:${variant.style}`"
          class="flex h-9 items-center rounded-lg border px-3 text-sm"
          :class="
            chosenChip && isSameVariant(variant, chosenChip) ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-foreground'
          "
          :style="{ fontFamily: `'${selected.cssFamilyName}', serif`, fontWeight: variant.weight, fontStyle: variant.style }"
          >{{ fontVariantLabel(variant, t) }}</span
        >
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useChipInput } from '@/composables/useChipInput'
import { useI18n } from 'vue-i18n'
import { X } from '@lucide/vue'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    modelValue: string[]
    placeholder?: string
    /** Omit for a free-text list: chips are whatever is typed, with no suggestion dropdown. */
    searchFn?: (q: string) => Promise<string[]>
    /** Returns null to reject an entry, so a list with a format can enforce it as it is typed. */
    normalize?: (raw: string) => string | null
    disabled?: boolean
    controlClass?: string
    inputId?: string
    inputMode?: 'numeric' | 'text'
    describedBy?: string
    invalid?: boolean
    minSearchLength?: number
    splitOnSeparators?: boolean
    maxItems?: number
    removeLabel?: string
  }>(),
  { splitOnSeparators: true },
)

const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const { input, query, results, showDropdown, activeIndex, full, addItem, removeItem, commitPending, onInput, onKeydown, onBlur } = useChipInput(
  props,
  (items) => emit('update:modelValue', items),
)
const listId = useId()
const inputPlaceholder = computed(() => {
  if (full.value) return ''
  if (props.modelValue.length === 0) return props.placeholder ?? t('components.ui.chipInput.typeAndEnter')
  return props.placeholder === undefined ? t('components.ui.chipInput.pressEnter') : ''
})
function preventFocus(event: Event) {
  event.preventDefault()
}
defineExpose({ commitPending })
</script>

<template>
  <Popover v-model:open="showDropdown">
    <PopoverAnchor as-child>
      <div
        class="min-h-10 flex flex-wrap gap-1.5 rounded-md border bg-background px-3 py-2 text-sm focus-within:ring-1 focus-within:ring-ring transition-shadow"
        :class="[props.disabled ? 'cursor-not-allowed opacity-60' : '', props.invalid ? 'border-destructive' : 'border-input', props.controlClass]"
      >
        <span v-for="item in modelValue" :key="item" class="flex max-w-full items-center gap-1 bg-muted px-2 py-0.5 rounded-full text-xs">
          <span class="min-w-0 break-words">{{ item }}</span>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground transition-colors disabled:pointer-events-none"
            :disabled="props.disabled"
            @click="removeItem(item)"
          >
            <X class="size-3" aria-hidden="true" />
            <span class="sr-only">{{ removeLabel ?? t('components.ui.chipInput.remove', { value: item }) }}</span>
          </button>
        </span>
        <input
          :id="inputId"
          ref="input"
          :role="searchFn ? 'combobox' : undefined"
          :aria-expanded="searchFn ? showDropdown : undefined"
          :aria-controls="searchFn ? listId : undefined"
          :aria-autocomplete="searchFn ? 'list' : undefined"
          :aria-activedescendant="showDropdown && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined"
          :readonly="full"
          :tabindex="full ? -1 : undefined"
          :class="full ? 'w-0 min-w-0 flex-none' : 'flex-1 min-w-24'"
          v-model="query"
          enterkeyhint="enter"
          class="bg-transparent outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          :placeholder="inputPlaceholder"
          :disabled="props.disabled"
          :inputmode="inputMode"
          :aria-describedby="describedBy"
          :aria-invalid="invalid || undefined"
          @input="onInput"
          @keydown="onKeydown"
          @blur="onBlur"
        />
      </div>
    </PopoverAnchor>
    <PopoverContent
      v-if="showDropdown"
      align="start"
      class="w-(--reka-popover-trigger-width) max-h-48 overflow-y-auto p-1"
      @open-auto-focus="preventFocus"
      @close-auto-focus="preventFocus"
      @interact-outside="preventFocus"
    >
      <ul :id="listId" role="listbox">
        <li
          v-for="(item, index) in results"
          :id="`${listId}-${index}`"
          :key="item"
          role="option"
          :aria-selected="index === activeIndex"
          class="cursor-pointer rounded-sm px-3 py-2 text-sm hover:bg-muted"
          :class="index === activeIndex ? 'bg-muted' : ''"
          @mousedown.prevent="addItem(item)"
        >
          {{ item }}
        </li>
      </ul>
    </PopoverContent>
  </Popover>
</template>

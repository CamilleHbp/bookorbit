import { computed, onScopeDispose, ref, watch } from 'vue'

export interface ChipInputOptions {
  modelValue: string[]
  searchFn?: (q: string) => Promise<string[]>
  normalize?: (raw: string) => string | null
  disabled?: boolean
  minSearchLength?: number
  splitOnSeparators?: boolean
  maxItems?: number
}

export function useChipInput(props: ChipInputOptions, update: (items: string[]) => void) {
  const input = ref<HTMLInputElement | null>(null)
  const query = ref('')
  const results = ref<string[]>([])
  const showDropdown = ref(false)
  const activeIndex = ref(-1)
  const full = computed(() => props.modelValue.length >= (props.maxItems ?? Infinity))
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  function close() {
    clearTimeout(timer)
    generation++
    showDropdown.value = false
    results.value = []
    activeIndex.value = -1
  }
  function accept(raw: string) {
    const value = raw.trim()
    if (!value) return null
    return props.normalize ? props.normalize(value) : value
  }
  function addItem(raw: string) {
    if (props.disabled || full.value) return false
    const value = accept(raw)
    if (!value) return false
    const next = [...props.modelValue]
    if (!next.includes(value)) next.push(value)
    if (JSON.stringify(next) !== JSON.stringify(props.modelValue)) update(next)
    query.value = ''
    close()
    return true
  }
  function commitPending() {
    return !query.value.trim() || addItem(query.value)
  }
  function onInput() {
    close()
    if (props.disabled) return
    if (props.splitOnSeparators !== false && /[,\n\t;]/.test(query.value)) {
      const parts = query.value.split(/[,\n\t;]/)
      const trailing = parts.pop() ?? ''
      const next = [...props.modelValue]
      for (const part of parts) {
        const value = accept(part)
        if (value && !next.includes(value) && next.length < (props.maxItems ?? Infinity)) next.push(value)
      }
      if (next.length !== props.modelValue.length) update(next)
      query.value = trailing
    }
    const q = query.value.trim()
    if (!props.searchFn || q.length < (props.minSearchLength ?? 1) || full.value) return
    const current = generation
    const search = props.searchFn
    timer = setTimeout(async () => {
      try {
        const matches = await search(q)
        if (current !== generation || props.disabled) return
        results.value = matches.filter((item) => !props.modelValue.includes(item)).slice(0, 20)
        showDropdown.value = results.value.length > 0
      } catch {
        if (current === generation) close()
      }
    }, 200)
  }
  function removeItem(item: string) {
    if (props.disabled) return
    update(props.modelValue.filter((value) => value !== item))
  }
  function onKeydown(event: KeyboardEvent) {
    if (props.disabled || event.isComposing) return
    if (event.key === 'Escape' && showDropdown.value) {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (showDropdown.value && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      activeIndex.value =
        activeIndex.value < 0 ? (delta > 0 ? 0 : results.value.length - 1) : (activeIndex.value + delta + results.value.length) % results.value.length
    } else if (event.key === 'Enter' && query.value.trim()) {
      event.preventDefault()
      addItem(results.value[activeIndex.value] ?? query.value)
    } else if (event.key === 'Backspace' && !query.value && props.modelValue.length) {
      removeItem(props.modelValue[props.modelValue.length - 1]!)
    }
  }
  function onBlur() {
    commitPending()
    close()
  }
  watch(
    () => props.disabled,
    (disabled) => {
      if (disabled) close()
    },
  )
  onScopeDispose(close)
  return {
    input,
    query,
    results,
    showDropdown,
    activeIndex,
    full,
    addItem,
    removeItem,
    commitPending,
    onInput,
    onKeydown,
    onBlur,
  }
}

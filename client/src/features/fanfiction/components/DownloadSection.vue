<script setup lang="ts">
import { ref, useId } from 'vue'
import { ChevronDown } from '@lucide/vue'
const props = defineProps<{ libraryId: number; section: string; title: string; count: number }>()
const key = `bookorbit:downloads:${props.libraryId}:${props.section}`
const id = useId()
const open = ref(true)
try {
  open.value = localStorage.getItem(key) !== 'closed'
} catch {
  /* Storage is optional. */
}
function toggle() {
  open.value = !open.value
  try {
    localStorage.setItem(key, open.value ? 'open' : 'closed')
  } catch {
    /* Keep the session preference. */
  }
}
</script>
<template>
  <section>
    <h2>
      <button
        type="button"
        class="group flex w-full min-h-12 items-center gap-3 border-b border-border text-start text-lg font-semibold hover:text-primary focus-visible:outline-ring"
        :aria-expanded="open"
        :aria-controls="id"
        @click="toggle"
      >
        <span>{{ title }}</span
        ><span class="text-sm font-normal text-muted-foreground tabular-nums">{{ count }}</span
        ><ChevronDown
          class="ms-auto size-4 text-muted-foreground transition-transform motion-reduce:transition-none"
          :class="{ '-rotate-90': !open }"
          aria-hidden="true"
        />
      </button>
    </h2>
    <div :id="id" :hidden="!open"><slot v-if="open" /></div>
  </section>
</template>

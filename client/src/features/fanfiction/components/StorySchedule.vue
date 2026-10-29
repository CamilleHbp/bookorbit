<script setup lang="ts">
import { computed, ref, watch, useId } from 'vue'
import { useI18n } from 'vue-i18n'
const value = defineModel<string>({ required: true })
defineProps<{ disabled?: boolean }>()
const { t } = useI18n()
const id = useId()
const custom = ref(false)
let editedValue: string | undefined
watch(
  value,
  (current) => {
    if (editedValue === current) {
      editedValue = undefined
      return
    }
    custom.value = !['manual', '60', '1440', '10080'].includes(current)
  },
  { immediate: true },
)
const preset = computed({
  get: () => (custom.value ? 'custom' : value.value),
  set: (next: string) => {
    custom.value = next === 'custom'
    editedValue = custom.value ? '1440' : next
    value.value = editedValue
  },
})
function editInterval(event: Event) {
  editedValue = (event.target as HTMLInputElement).value
  value.value = editedValue
}
</script>
<template>
  <div class="space-y-2 text-sm">
    <label :for="id">{{ t('fanfiction.schedule') }}</label>
    <select :id="id" v-model="preset" :disabled="disabled" class="border-input bg-background block min-h-11 w-full rounded-md border p-2">
      <option value="manual">{{ t('fanfiction.manualOnly') }}</option>
      <option value="60">{{ t('fanfiction.hourly') }}</option>
      <option value="1440">{{ t('fanfiction.daily') }}</option>
      <option value="10080">{{ t('fanfiction.weekly') }}</option>
      <option value="custom">{{ t('fanfiction.customSchedule') }}</option>
    </select>
    <label v-if="custom" class="block space-y-1"
      >{{ t('fanfiction.intervalMinutes') }}
      <input
        :value="value"
        @input="editInterval"
        type="number"
        min="60"
        max="525600"
        required
        :disabled="disabled"
        class="border-input bg-background block min-h-11 w-full rounded-md border p-2"
      />
    </label>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FanfictionTagRule } from '@bookorbit/types'
import { Trash2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import ChipInput from '@/components/ui/ChipInput.vue'
import { useTagSearch } from '@/features/book/composables/useTagSearch'
const rules = defineModel<FanfictionTagRule[]>({ required: true })
defineProps<{ disabled?: boolean }>()
const { t } = useI18n()
const { search } = useTagSearch()
const id = useId()
const keys = new WeakMap<FanfictionTagRule, string>()
function ruleKey(rule: FanfictionTagRule) {
  if (!keys.has(rule)) keys.set(rule, crypto.randomUUID())
  return keys.get(rule)!
}
const tagInputs = ref<InstanceType<typeof ChipInput>[]>([])
const invalid = ref(false)
function commitPending() {
  const committed = tagInputs.value.every((input) => input.commitPending())
  invalid.value =
    !committed || duplicate.value || rules.value.some((rule) => !rule.remoteTag.trim() || !rule.targetTag.trim() || rule.targetTag.length > 500)
  return !invalid.value
}
defineExpose({ commitPending })
const duplicate = computed(() => new Set(rules.value.map((rule) => rule.remoteTag.trim().toLowerCase())).size !== rules.value.length)
function addRule() {
  if (rules.value.length < 100) rules.value.push({ remoteTag: '', targetTag: '' })
}
function removeRule(index: number) {
  rules.value.splice(index, 1)
}
function updateTarget(index: number, values: string[]) {
  rules.value[index]!.targetTag = values[0] ?? ''
}
</script>
<template>
  <fieldset :disabled="disabled" class="space-y-3">
    <legend class="text-sm font-medium">{{ t('fanfiction.tagRules') }}</legend>
    <p class="text-xs text-muted-foreground">{{ t('fanfiction.tagRulesHelp') }}</p>
    <div
      v-for="(rule, index) in rules"
      :key="ruleKey(rule)"
      class="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
    >
      <label class="col-span-2 min-w-0 space-y-1 text-sm sm:col-span-1" :for="`${id}-remote-${index}`">
        <span>{{ t('fanfiction.remoteTag') }}</span>
        <input
          :id="`${id}-remote-${index}`"
          v-model="rule.remoteTag"
          required
          maxlength="500"
          class="min-h-10 w-full rounded-md border border-input bg-background px-3 py-2"
        />
      </label>
      <div class="min-w-0 space-y-1 text-sm">
        <label :for="`${id}-target-${index}`">{{ t('fanfiction.targetTag') }}</label>
        <ChipInput
          ref="tagInputs"
          :input-id="`${id}-target-${index}`"
          :model-value="rule.targetTag ? [rule.targetTag] : []"
          :search-fn="search"
          :min-search-length="3"
          :max-items="1"
          :disabled="disabled"
          @update:model-value="updateTarget(index, $event)"
        />
      </div>
      <Button type="button" variant="ghost" :aria-label="t('fanfiction.removeTagRule')" @click="removeRule(index)"><Trash2 class="size-4" /></Button>
    </div>
    <p v-if="invalid && !duplicate" role="alert" class="text-sm text-destructive">{{ t('fanfiction.invalidTagRule') }}</p>
    <p v-if="duplicate" role="alert" class="text-sm text-destructive">{{ t('fanfiction.duplicateTagRule') }}</p>
    <Button type="button" variant="outline" :disabled="disabled || rules.length >= 100" @click="addRule">{{ t('fanfiction.addTagRule') }}</Button>
  </fieldset>
</template>

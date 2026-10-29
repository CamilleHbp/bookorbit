<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ArrowLeft, ArrowRight, Check } from '@lucide/vue'
import { Button } from '@/components/ui/button'
defineProps<{ busy: boolean; hasPrevious: boolean; saved?: boolean; canSave: boolean }>()
const emit = defineEmits<{ previous: []; skip: []; save: [] }>()
const { t } = useI18n()
function previous() {
  emit('previous')
}
function skip() {
  emit('skip')
}
function save() {
  emit('save')
}
</script>
<template>
  <div
    class="sticky bottom-0 z-10 -mx-4 -mb-4 grid grid-cols-2 items-center gap-2 rounded-b-xl border-t border-border bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex sm:flex-wrap"
  >
    <Button type="button" variant="ghost" class="min-h-11" :disabled="busy || !hasPrevious" @click="previous">
      <ArrowLeft class="size-4" aria-hidden="true" />{{ t('common.previous') }}
    </Button>
    <div class="contents sm:ml-auto sm:flex sm:flex-wrap sm:gap-2">
      <Button type="button" variant="outline" class="min-h-11" :disabled="busy" @click="skip">
        {{ t(saved ? 'common.next' : 'fanfiction.reviewQueue.skip') }}<ArrowRight class="size-4" aria-hidden="true" />
      </Button>
      <Button v-if="!saved && canSave" type="button" class="col-span-2 min-h-11" :disabled="busy" @click="save">
        <Check class="size-4" aria-hidden="true" />{{ t(busy ? 'fanfiction.reviewQueue.saving' : 'fanfiction.reviewQueue.save') }}
      </Button>
    </div>
  </div>
</template>

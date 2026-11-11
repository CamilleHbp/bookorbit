<script setup lang="ts">
import type { FanfictionDownloadSection, FanfictionDownloadRow } from '@bookorbit/types'
import { useI18n } from 'vue-i18n'
import { useDownloadQueue } from '../composables/useDownloadQueue'
import DownloadRow from './DownloadRow.vue'
import FanfictionPagination from './FanfictionPagination.vue'
const props = defineProps<{ libraryId: number; section: FanfictionDownloadSection; groupKey: string }>()
const emit = defineEmits<{ inspect: [row: FanfictionDownloadRow] }>()
const { t } = useI18n()
const { snapshot, offsets, busy, error, reload, refresh } = useDownloadQueue(props.libraryId, { section: props.section, key: props.groupKey })
function inspect(row: FanfictionDownloadRow) {
  emit('inspect', row)
}
function next() {
  void reload(props.section, 20)
}
function previous() {
  void reload(props.section, -20)
}
</script>
<template>
  <p v-if="error" role="alert" class="text-sm text-destructive">
    {{ t('fanfiction.downloads.loadError') }} <button class="underline" @click="refresh">{{ t('fanfiction.refresh') }}</button>
  </p>
  <p v-if="!snapshot && !error" role="status">{{ t('common.loading') }}</p>
  <template v-if="snapshot"
    ><DownloadRow v-for="row in snapshot.items" :key="row.id" :library-id="libraryId" :row="row" @inspect="inspect" />
    <FanfictionPagination
      :label="t('fanfiction.downloads.affected')"
      :page="offsets[section] / 20 + 1"
      :busy="busy"
      :previous="offsets[section] > 0"
      :next="offsets[section] + 20 < snapshot.totals[section]"
      @next="next"
      @previous="previous"
  /></template>
</template>

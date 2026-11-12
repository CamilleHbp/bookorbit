<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUpRight, CircleCheck, CloudDownload } from '@lucide/vue'
import type { FanfictionDownloadRow } from '@bookorbit/types'
import { sections, useDownloadQueue } from '../composables/useDownloadQueue'
import DownloadSection from './DownloadSection.vue'
import DownloadRow from './DownloadRow.vue'
import DownloadJobDetail from './DownloadJobDetail.vue'
import FanfictionPagination from './FanfictionPagination.vue'
const props = defineProps<{ libraryId: number }>()
const { t, locale } = useI18n()
const { snapshot, busy, error, lastSeen, refresh, reload, offsets } = useDownloadQueue(props.libraryId)
const visible = computed(() => sections.filter((key) => key === 'running' || snapshot.value?.totals[key]))
const selected = ref<FanfictionDownloadRow>()
const detail = ref<InstanceType<typeof DownloadJobDetail>>()
let opener: HTMLElement | null = null
const list = ref<HTMLElement>()
const verificationDialog = ref<HTMLDialogElement>()
const dismissed = ref(new Set<string>())
const blockedStories = computed(() =>
  (snapshot.value?.items ?? []).flatMap((row) => {
    if (!['fanfiction_net_browser_verification', 'source_browser_verification'].includes(row.code ?? '') || !row.verificationUrl) return []
    const site = row.site.replace(/^www\./, '')
    if (site === 'archiveofourown.org') return []
    try {
      const url = new URL(row.verificationUrl)
      if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hostname.replace(/^www\./, '') !== site) return []
      return [{ key: row.jobId ?? row.id, url: url.href, site }]
    } catch {
      return []
    }
  }),
)
const blockedStory = computed(() => blockedStories.value.find((item) => !dismissed.value.has(item.key)))
watch(
  blockedStory,
  (story) => {
    if (story && !verificationDialog.value?.open) verificationDialog.value?.showModal()
    else if (!story) verificationDialog.value?.close()
  },
  { flush: 'post' },
)
function closeVerification() {
  if (blockedStory.value) dismissed.value.add(blockedStory.value.key)
}
function inspect(row: FanfictionDownloadRow) {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  selected.value = row
}
async function close() {
  selected.value = undefined
  await nextTick()
  ;(opener?.isConnected ? opener : list.value)?.focus()
  refresh()
}
defineExpose({ reload: refresh, canLeave: () => detail.value?.canLeave() ?? true })
</script>
<template>
  <dialog
    ref="verificationDialog"
    :aria-label="t('fanfiction.connections.verifyStory')"
    @cancel.prevent="closeVerification"
    class="m-auto max-w-sm space-y-4 rounded-lg bg-background p-5 text-foreground backdrop:bg-black/50"
  >
    <p>{{ t('fanfiction.connections.verifyPrompt', { site: blockedStory?.site }) }}</p>
    <div class="flex justify-between gap-3">
      <a v-if="blockedStory" :href="blockedStory.url" class="text-primary underline">{{ t('fanfiction.connections.verifyStory') }}</a>
      <button type="button" @click="closeVerification">{{ t('common.close') }}</button>
    </div>
  </dialog>
  <DownloadJobDetail ref="detail" v-if="selected" :key="selected.id" :row="selected" :checked-at="lastSeen" :library-id="libraryId" @close="close" />
  <div v-show="!selected" ref="list" tabindex="-1" class="space-y-6 focus:outline-none">
    <div v-if="error" role="alert" class="rounded-lg border border-warning p-3 text-sm">
      <p>
        {{ t('fanfiction.downloads.loadError') }}
        <span v-if="lastSeen">{{ t('fanfiction.downloads.asOf', { time: lastSeen.toLocaleTimeString(locale) }) }}</span>
        <button type="button" class="text-primary underline" @click="refresh">{{ t('fanfiction.refresh') }}</button>
      </p>
    </div>
    <p v-if="!snapshot && !error" role="status">{{ t('common.loading') }}</p>
    <template v-if="snapshot">
      <a v-for="story in blockedStories" :key="story.key" :href="story.url" class="block text-primary underline"
        >{{ story.site }}: {{ t('fanfiction.connections.verifyStory') }}</a
      >
      <DownloadSection
        v-for="key in visible"
        :key="key"
        :library-id="libraryId"
        :section="key"
        :title="t(`fanfiction.downloads.${key}`)"
        :count="snapshot.totals[key]"
      >
        <p v-if="key === 'running' && !snapshot.totals.running" class="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <CloudDownload class="size-4" aria-hidden="true" />{{ t('fanfiction.downloads.idle') }}
        </p>
        <DownloadRow
          v-for="row in snapshot.items.filter((item) => item.section === key)"
          :key="row.id"
          :library-id="libraryId"
          :row="row"
          @retried="refresh"
          @inspect="inspect"
        />
        <FanfictionPagination
          :label="t(`fanfiction.downloads.${key}`)"
          :busy="busy"
          :page="offsets[key] / 20 + 1"
          :previous="offsets[key] > 0"
          :next="offsets[key] + 20 < snapshot.totals[key]"
          @next="reload(key, 20)"
          @previous="reload(key, -20)"
        />
      </DownloadSection>
      <DownloadSection
        v-if="snapshot.recent.length"
        :library-id="libraryId"
        section="finished"
        :title="t('fanfiction.downloads.finished')"
        :count="snapshot.recent.length"
      >
        <RouterLink
          v-for="book in snapshot.recent"
          :key="book.id"
          :to="{ name: 'book-detail', params: { bookId: book.bookId } }"
          class="flex min-h-14 items-center gap-3 border-b border-border/70 py-2 hover:text-primary"
          ><CircleCheck class="size-4 shrink-0 text-primary" aria-hidden="true" /><span class="flex-1 font-medium break-words">{{ book.title }}</span
          ><span class="text-sm">{{ t('fanfiction.openBook') }}</span
          ><ArrowUpRight class="size-4" aria-hidden="true"
        /></RouterLink>
      </DownloadSection>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { FanfictionDiscoveryCandidate, FanfictionProfileSummary } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { discoverySources, isDiscoveryReady } from '../composables/discoveryReview'

const props = defineProps<{
  website: string
  books: FanfictionDiscoveryCandidate[]
  profiles: FanfictionProfileSummary[]
  locked: boolean
  reviewable: boolean
  allMatching: boolean
}>()
const selected = defineModel<string[]>('selected', { required: true })
const emit = defineEmits<{
  link: [ids: string[], profile: string, source?: string]
  filter: [website: string]
}>()
const { t } = useI18n()
const profileChoices = defineModel<Record<string, string>>('profileChoices', { required: true })
const sourceChoices = defineModel<Record<string, string>>('sourceChoices', { required: true })
function isReady(book: FanfictionDiscoveryCandidate) {
  return isDiscoveryReady(book, profileChoices.value[book.id], sourceChoices.value[book.id])
}
const ready = computed(() => props.books.filter(isReady))
const canLinkGroup = computed(() => selectedBooks.value.length > 0 && selectedBooks.value.every(isReady))
const selectedBooks = computed(() => props.books.filter((book) => selected.value.includes(book.id)))
const needsChoice = computed(() => props.books.length - ready.value.length)
function profileName(book: FanfictionDiscoveryCandidate) {
  const choice = profileChoices.value[book.id]
  if (choice && choice !== 'auto') return props.profiles.find((profile) => profile.id === choice)?.name ?? t('fanfiction.noProfile')
  return book.profileMatch?.profile?.name ?? t('fanfiction.noProfile')
}
function selectReady() {
  selected.value = [...new Set([...selected.value, ...ready.value.map((book) => book.id)])]
}
function clearGroup() {
  const ids = new Set(props.books.map((book) => book.id))
  selected.value = selected.value.filter((id) => !ids.has(id))
}
const allReadySelected = computed(() => ready.value.length > 0 && ready.value.every((book) => selected.value.includes(book.id)))
function toggleGroup() {
  if (allReadySelected.value) clearGroup()
  else selectReady()
}
function linkGroup() {
  emit(
    'link',
    selectedBooks.value.map((book) => book.id),
    'auto',
  )
}
function filterWebsite() {
  emit('filter', props.website)
}
function linkBook(book: FanfictionDiscoveryCandidate) {
  if (!isReady(book)) return
  const sources = discoverySources(book)
  emit('link', [book.id], profileChoices.value[book.id] ?? 'auto', sourceChoices.value[book.id] || sources[0])
}
</script>
<template>
  <section class="space-y-3" :aria-label="website || t('fanfiction.discovery.websiteUnknown')">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <h3 class="break-words text-lg font-semibold">{{ website || t('fanfiction.discovery.websiteUnknown') }}</h3>
        <p class="text-muted-foreground text-sm">
          {{ t('fanfiction.discovery.booksOnPage', { count: books.length }) }}
          <template v-if="reviewable">
            · {{ t('fanfiction.discovery.readyCount', { count: ready.length }) }} ·
            {{ t('fanfiction.discovery.needsChoiceCount', { count: needsChoice }) }}</template
          >
        </p>
      </div>
      <Button v-if="website" variant="ghost" :disabled="locked" @click="filterWebsite">{{ t('fanfiction.discovery.onlyWebsite') }}</Button>
    </header>
    <div v-if="reviewable && !allMatching" class="flex flex-wrap items-center justify-between gap-2">
      <label class="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          :checked="allReadySelected"
          :indeterminate="selectedBooks.length > 0 && !allReadySelected"
          :disabled="locked || !ready.length"
          class="accent-primary size-4"
          @change="toggleGroup"
        />
        {{ t('fanfiction.discovery.selectReady') }}
      </label>
      <Button variant="outline" :disabled="locked || !canLinkGroup" @click="linkGroup">{{
        t('fanfiction.discovery.linkCount', { count: selectedBooks.length })
      }}</Button>
    </div>
    <div class="border-border divide-border divide-y border-y">
      <article v-for="book in books" :key="book.id" class="py-4">
        <div class="flex items-start gap-3">
          <label v-if="reviewable" class="flex min-h-11 min-w-11 items-center justify-center">
            <input
              v-if="allMatching"
              type="checkbox"
              checked
              disabled
              :aria-label="t('fanfiction.discovery.selectBook', { title: book.title })"
              class="accent-primary size-4"
            />
            <input
              v-else
              v-model="selected"
              type="checkbox"
              :value="book.id"
              :disabled="locked || (!isReady(book) && !selected.includes(book.id))"
              :aria-label="t('fanfiction.discovery.selectBook', { title: book.title })"
              class="accent-primary size-4"
            />
          </label>
          <div class="min-w-0 flex-1 space-y-1">
            <RouterLink :to="{ name: 'book-detail', params: { bookId: book.bookId } }" class="text-primary font-medium hover:underline">{{
              book.title || t('fanfiction.openBook')
            }}</RouterLink>
            <p class="text-muted-foreground text-sm">
              {{ book.authors.join(', ') }} · {{ t('fanfiction.chapterCount', { count: book.chapterCount }) }}
            </p>
            <p v-if="isReady(book)" class="text-sm">{{ t('fanfiction.profile') }}: {{ profileName(book) }}</p>
            <p v-if="reviewable && !isReady(book)" class="text-sm font-medium">{{ t('fanfiction.discovery.needsChoice') }}</p>
            <p v-if="book.errorCode" class="text-destructive text-sm">{{ t(`fanfiction.errors.${book.errorCode}`) }}</p>
            <details v-if="reviewable" :open="book.state !== 'pending' || book.profileMatch?.ambiguous" class="pt-1">
              <summary class="text-primary min-h-11 cursor-pointer py-2 text-sm underline-offset-4 hover:underline">
                {{ t(isReady(book) ? 'fanfiction.discovery.changeLink' : 'fanfiction.discovery.resolveLink') }}
              </summary>
              <div class="space-y-3 pb-2">
                <p v-if="book.profileMatch?.ambiguous && !isReady(book)" class="text-sm">{{ t('fanfiction.errors.profile_ambiguous') }}</p>
                <label v-if="discoverySources(book).length !== 1" class="block space-y-1 text-sm">
                  <span>{{ t('fanfiction.discovery.chooseSource') }}</span>
                  <select
                    v-model="sourceChoices[book.id]"
                    :disabled="locked || allMatching"
                    class="border-input bg-background min-h-11 w-full rounded-md border p-2"
                  >
                    <option value="">{{ t('fanfiction.discovery.chooseSource') }}</option>
                    <option v-for="url in discoverySources(book)" :key="url" :value="url">{{ url }}</option>
                  </select>
                </label>
                <p v-for="url in discoverySources(book)" v-else :key="url" class="text-muted-foreground break-all text-sm">{{ url }}</p>
                <div class="flex flex-wrap items-end gap-3">
                  <label class="block min-w-0 flex-1 space-y-1 text-sm">
                    <span>{{ t('fanfiction.profile') }}</span>
                    <select
                      v-model="profileChoices[book.id]"
                      :disabled="locked || allMatching"
                      class="border-input bg-background min-h-11 w-full rounded-md border p-2"
                    >
                      <option value="auto">{{ t('fanfiction.automaticProfile') }}</option>
                      <option value="public">{{ t('fanfiction.noProfile') }}</option>
                      <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
                    </select>
                  </label>
                  <Button variant="outline" :disabled="locked || allMatching || !isReady(book)" @click="linkBook(book)">{{
                    t('fanfiction.discovery.linkBook')
                  }}</Button>
                </div>
              </div>
            </details>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

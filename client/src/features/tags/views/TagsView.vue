<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronLeft, ChevronRight, LayoutGrid, List, Search, Tags, X } from '@lucide/vue'
import type { BookCard } from '@bookorbit/types'
import { useTagBrowser } from '../composables/useTagBrowser'
import TagGroupPanel from '@/features/tools/entity-manager/components/TagGroupPanel.vue'
import VirtualBookGrid from '@/features/book/components/VirtualBookGrid.vue'
import BookListRow from '@/features/book/components/BookListRow.vue'
import BookQuickView from '@/features/book/components/BookQuickView.vue'
import DeleteBookDialog from '@/features/book/components/DeleteBookDialog.vue'
import AddToCollectionSheet from '@/features/collection/components/AddToCollectionSheet.vue'
import { useDeleteBook } from '@/features/book/composables/useDeleteBook'
import { useDisplaySettings } from '@/composables/useDisplaySettings'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { usePageTitle } from '@/composables/usePageTitle'
import { useBookViewContext } from '@/features/book/composables/useBookViewContext'

const { t } = useI18n()
const router = useRouter()
const { hasPermission } = usePermissions()
const browser = useTagBrowser()
const { selected, match, tagSearch, tags, tagTotal, tagsLoading, tagsError, prefix, page, totalPages, searchQuery, sortKey, books } = browser
const { slots, total, loading, initialized, error, contiguousPrefix, ensureRange, reset } = books
const { portraitCoverSize, gridGap } = useDisplaySettings()
usePageTitle(computed(() => t('tagBrowser.title')))
useBookViewContext(slots, total, browser.loadMore)
const view = ref<'grid' | 'list'>('grid')
const pickerExpanded = ref(false)
const resultHeading = ref<HTMLElement | null>(null)
const hasMore = computed(() => contiguousPrefix.value.length < total.value)
const activeGroup = computed(() => (prefix.value === undefined ? '' : prefix.value || t('tools.tagManager.ungrouped')))
function togglePicker() {
  pickerExpanded.value = !pickerExpanded.value
}
function showBooks() {
  pickerExpanded.value = false
  void nextTick(() => resultHeading.value?.focus())
}
function showGrid() {
  view.value = 'grid'
}
function showList() {
  view.value = 'list'
}
function manageTags() {
  void router.push({ name: 'tools-tags' })
}
const quickId = ref<number | null>(null)
const quickOpen = ref(false)
const collectionOpen = ref(false)
const collectionIds = ref<number[]>([])
const { pendingId, deleting, promptDelete, cancelDelete, confirmDelete } = useDeleteBook(() => {
  void reset()
  void browser.loadTags()
})
function handleBookAction(book: BookCard, action: string) {
  if (action === 'quick-view') {
    quickId.value = book.id
    quickOpen.value = true
  } else if (action === 'add-to-collection') {
    collectionIds.value = [book.id]
    collectionOpen.value = true
  } else if (action === 'delete') promptDelete(book.id)
  else if (action === 'edit-metadata') void router.push(`/book/${book.id}/edit`)
}
function handleQuickAction(action: 'add-to-collection' | 'delete') {
  if (quickId.value === null) return
  quickOpen.value = false
  if (action === 'delete') promptDelete(quickId.value)
  else {
    collectionIds.value = [quickId.value]
    collectionOpen.value = true
  }
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4 p-4 sm:p-6">
    <header class="flex items-center justify-between gap-3">
      <h1 class="flex items-center gap-2 text-xl font-semibold"><Tags :size="22" aria-hidden="true" />{{ t('tagBrowser.title') }}</h1>
      <button
        v-if="hasPermission('library_edit_metadata')"
        type="button"
        class="min-h-10 rounded-md border border-input px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        @click="manageTags"
      >
        {{ t('tagBrowser.manage') }}
      </button>
    </header>
    <div class="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:gap-6">
      <aside
        class="flex min-h-0 shrink-0 flex-col lg:w-72 lg:border-e lg:border-border lg:pe-5"
        :class="pickerExpanded ? 'flex-1 lg:flex-none' : ''"
        :aria-label="t('tagBrowser.choose')"
      >
        <button
          type="button"
          class="flex min-h-11 items-center justify-between rounded-md border border-input px-3 text-sm font-medium lg:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :aria-expanded="pickerExpanded"
          aria-controls="tag-picker"
          @click="togglePicker"
        >
          <span
            >{{ t('tagBrowser.choose')
            }}<span v-if="selected.length" class="ms-2 text-muted-foreground">{{ t('tagBrowser.selected', { count: selected.length }) }}</span></span
          ><ChevronDown :size="16" aria-hidden="true" />
        </button>
        <div id="tag-picker" class="min-h-0 flex-col gap-3 pt-2 lg:flex lg:flex-1 lg:pt-0" :class="pickerExpanded ? 'flex flex-1' : 'hidden'">
          <TagGroupPanel :revision="0" :prefix="prefix" reader compact @filter="browser.setGroup" />
          <div v-if="activeGroup" class="flex items-center justify-between gap-2 text-xs">
            <span class="break-all">{{ t('tools.tagManager.activeGroup', { group: activeGroup }) }}</span
            ><button class="shrink-0 text-primary underline" type="button" @click="browser.clearGroup">{{ t('tools.tagManager.allTags') }}</button>
          </div>
          <label class="relative block"
            ><Search :size="16" class="pointer-events-none absolute start-3 top-3 text-muted-foreground" aria-hidden="true" /><input
              v-model="tagSearch"
              type="search"
              :aria-label="t('tagBrowser.searchTags')"
              :placeholder="t('tagBrowser.searchTags')"
              class="h-10 w-full rounded-md border border-input bg-background pe-3 ps-9 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          /></label>
          <p class="text-xs text-muted-foreground" aria-live="polite">{{ t('tools.tagManager.resultCount', { count: tagTotal }) }}</p>
          <div class="min-h-0 flex-1 overflow-y-auto" :aria-busy="tagsLoading">
            <p v-if="tagsLoading" role="status" class="py-3 text-sm text-muted-foreground">{{ t('common.loading') }}</p>
            <div v-else-if="tagsError" role="alert" class="space-y-2 py-3 text-sm">
              <p>{{ t('tagBrowser.tagsError') }}</p>
              <button type="button" class="text-primary underline" @click="browser.loadTags">{{ t('common.retry') }}</button>
            </div>
            <p v-else-if="!tags.length" class="py-3 text-sm text-muted-foreground">{{ t('tagBrowser.noTags') }}</p>
            <div v-else class="space-y-1">
              <label
                v-for="tag in tags"
                :key="tag.id"
                class="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-accent"
                :class="selected.includes(tag.name) ? 'bg-accent text-accent-foreground' : ''"
              >
                <input
                  type="checkbox"
                  class="size-4 shrink-0 accent-primary"
                  :checked="selected.includes(tag.name)"
                  :disabled="selected.length >= 50 && !selected.includes(tag.name)"
                  @change="browser.toggleTag(tag.name)"
                />
                <span class="min-w-0 flex-1 break-words">{{ tag.name }}</span
                ><span class="text-xs tabular-nums text-muted-foreground">{{ tag.bookCount }}</span>
              </label>
            </div>
          </div>
          <p v-if="selected.length >= 50" class="text-xs text-muted-foreground">{{ t('tagBrowser.limit') }}</p>
          <nav v-if="totalPages > 1" class="flex items-center justify-between gap-2" :aria-label="t('tagBrowser.choose')">
            <button
              type="button"
              :disabled="page <= 1"
              :aria-label="t('common.previous')"
              class="size-10 rounded-md border border-input disabled:opacity-40"
              @click="browser.previousPage"
            >
              <ChevronLeft :size="16" class="mx-auto" /></button
            ><span class="text-xs tabular-nums">{{ page }} / {{ totalPages }}</span
            ><button
              type="button"
              :disabled="page >= totalPages"
              :aria-label="t('common.next')"
              class="size-10 rounded-md border border-input disabled:opacity-40"
              @click="browser.nextPage"
            >
              <ChevronRight :size="16" class="mx-auto" />
            </button>
          </nav>
          <button type="button" class="min-h-10 rounded-md bg-primary px-3 text-sm text-primary-foreground lg:hidden" @click="showBooks">
            {{ t('tagBrowser.viewBooks') }}
          </button>
        </div>
      </aside>
      <section
        class="min-h-0 min-w-0 flex-1 flex-col gap-3"
        :class="pickerExpanded ? 'hidden lg:flex' : 'flex'"
        :aria-label="t('tagBrowser.viewBooks')"
      >
        <div class="flex flex-wrap items-center gap-2">
          <label class="flex items-center gap-2 text-sm"
            ><span class="text-muted-foreground">{{ t('tagBrowser.match') }}</span
            ><select
              :value="match"
              class="h-10 max-w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              @change="browser.setMatch"
            >
              <option value="all">{{ t('tagBrowser.all') }}</option>
              <option value="any">{{ t('tagBrowser.any') }}</option>
            </select></label
          >
          <button v-if="selected.length" type="button" class="min-h-10 px-2 text-sm text-primary hover:underline" @click="browser.clearTags">
            {{ t('tagBrowser.clear') }}
          </button>
        </div>
        <div
          v-if="selected.length"
          class="flex max-h-32 flex-wrap gap-2 overflow-y-auto"
          :aria-label="t('tagBrowser.selected', { count: selected.length })"
        >
          <button
            v-for="tag in selected"
            :key="tag"
            type="button"
            class="flex min-h-8 max-w-full items-center gap-2 rounded-md bg-accent px-2.5 py-1 text-sm text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="t('tagBrowser.remove', { tag })"
            @click="browser.toggleTag(tag)"
          >
            <span class="min-w-0 break-all">{{ tag }}</span
            ><X :size="14" class="shrink-0" aria-hidden="true" />
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <h2 ref="resultHeading" tabindex="-1" class="me-auto text-sm font-medium outline-none" aria-live="polite">
            {{ loading ? t('common.loading') : t('tagBrowser.books', { count: total }) }}
          </h2>
          <input
            v-model="searchQuery"
            type="search"
            :aria-label="t('tagBrowser.searchBooks')"
            :placeholder="t('tagBrowser.searchBooks')"
            class="order-first h-9 w-full min-w-0 basis-full rounded-md border border-input bg-background px-3 text-sm sm:order-none sm:w-auto sm:flex-1 sm:basis-auto sm:max-w-56 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <select
            v-model="sortKey"
            :aria-label="t('tagBrowser.sort')"
            class="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="title">{{ t('tagBrowser.titleSort') }}</option>
            <option value="addedAt">{{ t('tagBrowser.recentSort') }}</option>
            <option value="rating">{{ t('tagBrowser.ratingSort') }}</option>
          </select>
          <div class="flex rounded-md border border-input">
            <button
              type="button"
              :aria-label="t('tagBrowser.grid')"
              :aria-pressed="view === 'grid'"
              class="size-9 rounded-s-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :class="view === 'grid' ? 'bg-accent' : ''"
              @click="showGrid"
            >
              <LayoutGrid :size="16" class="mx-auto" /></button
            ><button
              type="button"
              :aria-label="t('tagBrowser.list')"
              :aria-pressed="view === 'list'"
              class="size-9 rounded-e-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :class="view === 'list' ? 'bg-accent' : ''"
              @click="showList"
            >
              <List :size="16" class="mx-auto" />
            </button>
          </div>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto" :aria-busy="loading">
          <div v-if="error" role="alert" class="space-y-3 py-10 text-center text-sm">
            <p>{{ t('tagBrowser.booksError') }}</p>
            <button type="button" class="text-primary underline" @click="reset">{{ t('common.retry') }}</button>
          </div>
          <div v-else-if="initialized && !loading && !total" class="space-y-3 py-16 text-center">
            <p class="font-medium">{{ t('tagBrowser.noBooks') }}</p>
            <p class="text-sm text-muted-foreground">{{ t('tagBrowser.noBooksHint') }}</p>
            <button v-if="selected.length" type="button" class="text-sm text-primary underline" @click="browser.clearTags">
              {{ t('tagBrowser.clear') }}
            </button>
          </div>
          <VirtualBookGrid
            v-else-if="view === 'grid'"
            :books="slots"
            :cover-size="portraitCoverSize"
            :grid-gap="gridGap"
            @range="ensureRange"
            @action="handleBookAction"
            @update:book="reset"
          />
          <div v-else class="divide-y divide-border">
            <BookListRow v-for="book in contiguousPrefix" :key="book.id" :book="book" @action="handleBookAction(book, $event)" /><button
              v-if="hasMore"
              type="button"
              class="my-4 min-h-10 w-full rounded-md border border-input text-sm hover:bg-accent"
              :disabled="loading"
              @click="browser.loadMore"
            >
              {{ t('tagBrowser.loadMore') }}
            </button>
          </div>
        </div>
      </section>
    </div>
    <BookQuickView :book-id="quickId" v-model:open="quickOpen" @action="handleQuickAction" />
    <AddToCollectionSheet v-model:open="collectionOpen" :selection-payload="{ bookIds: collectionIds }" />
    <DeleteBookDialog :open="pendingId !== null" :deleting="deleting" @confirm="confirmDelete" @cancel="cancelDelete" />
  </div>
</template>

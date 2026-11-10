<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Search, X, ChevronLeft, ChevronRight } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import TagMatchingPreview from './TagMatchingPreview.vue'
import { useTagMatching, type MatchingRow } from './composables/useTagMatching'
const { t } = useI18n()
const { hasPermission } = usePermissions()
const matching = reactive(useTagMatching())
const showingPreview = ref(false)
function openPreview() {
  showingPreview.value = true
}
async function reviewLabel(row: MatchingRow) {
  showingPreview.value = false
  matching.view = 'review'
  await matching.load()
  if (!matching.error) matching.edit(row)
}
function closePreview() {
  showingPreview.value = false
  void matching.load()
}
const canEdit = computed(() => hasPermission('library_edit_metadata'))
const tabs = ['matches', 'review', 'ignored'] as const
const fields = ['tags', 'genres', 'fandoms', 'characters', 'relationships', 'warnings', 'rating'] as const
const inputClass =
  'min-h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const hasMissingFandom = computed(() => matching.draft?.some((row) => row.bookId))
const singleDraft = computed(() => (matching.draft?.length === 1 ? matching.draft[0] : null))
const emptyText = computed(() => t(matching.view === 'review' ? 'tagMatching.reviewEmpty' : 'tagMatching.rulesEmpty'))
function initialize() {
  if (canEdit.value) void matching.load()
}
onMounted(initialize)
</script>
<template>
  <TagMatchingPreview v-if="showingPreview" @close="closePreview" @review="reviewLabel" />
  <section v-else class="flex h-full min-h-0 flex-col gap-4" :aria-label="t('tagMatching.title')">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-xl font-semibold">{{ t('tagMatching.title') }}</h1>
      <div v-if="canEdit" class="flex flex-wrap gap-2">
        <Button variant="outline" :disabled="!!matching.draft" @click="openPreview">{{ t('tagMatching.preview.title') }}</Button>
        <Button variant="outline" :disabled="!!matching.draft" @click="matching.addRule"
          ><Plus class="size-4" aria-hidden="true" />{{ t('tagMatching.add') }}</Button
        >
      </div>
    </header>
    <p v-if="!canEdit" class="text-sm text-muted-foreground">{{ t('tagMatching.permission') }}</p>
    <template v-else>
      <div class="flex flex-wrap gap-1 border-b border-border pb-2" role="group" :aria-label="t('tagMatching.views')">
        <Button
          v-for="tab in tabs"
          :key="tab"
          :variant="matching.view === tab ? 'secondary' : 'ghost'"
          :aria-pressed="matching.view === tab"
          :disabled="!!matching.draft"
          @click="matching.switchView(tab)"
          >{{ t(`tagMatching.${tab}`) }}</Button
        >
      </div>
      <p v-if="matching.notice" role="status" class="text-sm text-muted-foreground">{{ matching.notice }}</p>
      <div v-if="matching.error" role="alert" class="flex flex-wrap items-center gap-3 text-sm text-destructive">
        <p>{{ matching.error }}</p>
        <Button v-if="!matching.draft" variant="outline" @click="matching.load">{{ t('common.retry') }}</Button>
      </div>
      <form v-if="matching.draft" class="min-h-0 flex-1 space-y-4 overflow-y-auto pe-1" @submit.prevent="matching.saveMatch">
        <h2 class="text-base font-semibold">{{ t('tagMatching.editCount', { count: matching.draft.length }) }}</h2>
        <p v-if="hasMissingFandom" class="text-sm text-muted-foreground">{{ t('tagMatching.missingFandomHelp') }}</p>
        <RouterLink
          v-if="singleDraft?.bookId"
          :to="{ name: 'book-detail', params: { bookId: singleDraft.bookId } }"
          class="inline-block text-sm text-primary underline underline-offset-4"
          >{{ t('tagMatching.openBook') }}</RouterLink
        >
        <div v-if="singleDraft" class="grid gap-3 sm:grid-cols-2">
          <label class="space-y-1 text-sm sm:col-span-2"
            ><span>{{ t(singleDraft.bookId ? 'tagMatching.book' : 'tagMatching.incoming') }}</span
            ><input
              v-model="singleDraft.value"
              required
              :maxlength="singleDraft.bookId ? undefined : 500"
              :readonly="matching.view === 'review' && !!singleDraft.value && singleDraft.bookCount > 0"
              :class="inputClass"
          /></label>
          <label class="space-y-1 text-sm"
            ><span>{{ t('tagMatching.source') }}</span
            ><input
              v-model="singleDraft.source"
              :readonly="!!singleDraft.bookId"
              maxlength="200"
              :class="inputClass"
              :placeholder="t('tagMatching.allSources')"
          /></label>
          <label class="space-y-1 text-sm"
            ><span>{{ t('tagMatching.field') }}</span
            ><select v-model="singleDraft.field" :disabled="!!singleDraft.bookId" :class="inputClass">
              <option v-for="item in fields" :key="item" :value="item">{{ t(`tagMatching.fields.${item}`) }}</option>
            </select></label
          >
        </div>
        <ul v-else class="max-h-32 space-y-1 overflow-y-auto text-sm">
          <li v-for="row in matching.draft" :key="matching.key(row)" class="break-words">{{ row.value }}</li>
        </ul>
        <fieldset class="space-y-3" :disabled="matching.saving">
          <legend class="mb-2 text-sm font-medium">{{ t('tagMatching.destinations') }}</legend>
          <ul class="space-y-1">
            <li v-for="(target, index) in matching.targets" :key="`${target.field}:${target.id}`" class="flex items-center gap-2 text-sm">
              <span class="min-w-0 flex-1 break-words"
                >{{ target.name }} <span class="text-muted-foreground">({{ t(`tagMatching.fields.${target.field}`) }})</span></span
              ><Button
                variant="ghost"
                type="button"
                :aria-label="t('tagMatching.removeTarget', { name: target.name })"
                @click="matching.removeTarget(index)"
                ><X class="size-4"
              /></Button>
            </li>
            <li v-for="(target, index) in matching.newTargets" :key="`${target.field}:${target.name}`" class="flex items-center gap-2 text-sm">
              <span class="min-w-0 flex-1 break-words"
                >{{ target.name }} <span class="text-muted-foreground">({{ t('tagMatching.newLabel') }})</span></span
              ><Button
                variant="ghost"
                type="button"
                :aria-label="t('tagMatching.removeTarget', { name: target.name })"
                @click="matching.removeNewTarget(index)"
                ><X class="size-4"
              /></Button>
            </li>
          </ul>
          <div class="grid gap-2 sm:grid-cols-[10rem_1fr]">
            <label class="space-y-1 text-sm"
              ><span>{{ t('tagMatching.field') }}</span
              ><select v-model="matching.targetField" :class="inputClass">
                <option value="tags">{{ t('tagMatching.fields.tags') }}</option>
                <option value="genres">{{ t('tagMatching.fields.genres') }}</option>
              </select></label
            >
            <label class="space-y-1 text-sm"
              ><span>{{ t('tagMatching.searchTarget') }}</span
              ><input
                v-model="matching.targetSearch"
                type="search"
                maxlength="200"
                :class="inputClass"
                :aria-busy="matching.suggestionsLoading"
                @keydown.enter="matching.acceptTargetSearch"
            /></label>
          </div>
          <p v-if="matching.suggestionsLoading" role="status" class="text-sm text-muted-foreground">{{ t('tagMatching.searching') }}</p>
          <p v-else-if="matching.suggestionsError" role="alert" class="text-sm text-destructive">{{ matching.suggestionsError }}</p>
          <ul v-if="matching.canCreateTarget || matching.suggestions.length" class="divide-y divide-border rounded-md border border-border">
            <li v-if="matching.canCreateTarget">
              <button
                type="button"
                class="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-start text-sm font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                @click="matching.createTarget"
              >
                <Plus class="size-4 shrink-0" aria-hidden="true" />
                <span class="break-all">{{
                  t(matching.targetField === 'tags' ? 'tagMatching.createTag' : 'tagMatching.createGenre', { name: matching.targetSearch.trim() })
                }}</span>
              </button>
            </li>
            <li v-for="suggestion in matching.suggestions" :key="`${suggestion.field}:${suggestion.id}`">
              <button
                type="button"
                class="min-h-11 w-full px-3 py-2 text-start text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="matching.addTarget(suggestion)"
              >
                {{ suggestion.name }}
              </button>
            </li>
          </ul>
        </fieldset>
        <div class="sticky bottom-0 flex flex-wrap gap-2 border-t border-border bg-background py-3">
          <Button type="submit" :disabled="matching.saving">{{ t('tagMatching.save') }}</Button
          ><Button variant="outline" type="button" :disabled="matching.saving" @click="matching.ignore">{{ t('tagMatching.ignore') }}</Button
          ><Button variant="ghost" type="button" :disabled="matching.saving" @click="matching.cancel">{{ t('common.cancel') }}</Button>
        </div>
      </form>
      <template v-else>
        <div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_12rem]">
          <label class="relative"
            ><span class="sr-only">{{ t('tagMatching.search') }}</span
            ><Search class="pointer-events-none absolute start-3 top-3 size-4 text-muted-foreground" aria-hidden="true" /><input
              v-model="matching.search"
              type="search"
              :placeholder="t('tagMatching.search')"
              :class="[inputClass, 'ps-9']"
          /></label>
          <label
            ><span class="sr-only">{{ t('tagMatching.field') }}</span
            ><select v-model="matching.field" :class="inputClass">
              <option value="">{{ t('tagMatching.allFields') }}</option>
              <option v-for="item in fields" :key="item" :value="item">{{ t(`tagMatching.fields.${item}`) }}</option>
            </select></label
          >
          <label
            ><span class="sr-only">{{ t('tagMatching.source') }}</span
            ><input v-model="matching.source" :placeholder="t('tagMatching.allSources')" :class="inputClass"
          /></label>
        </div>
        <div class="flex items-center justify-between gap-2">
          <p class="text-sm tabular-nums text-muted-foreground" aria-live="polite">{{ t('tagMatching.count', { count: matching.total }) }}</p>
          <Button v-if="matching.selection.length" variant="outline" @click="matching.editSelected">{{
            t('tagMatching.editCount', { count: matching.selection.length })
          }}</Button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto" :aria-busy="matching.loading">
          <p v-if="matching.loading" role="status" class="py-8 text-sm text-muted-foreground">{{ t('common.loading') }}</p>
          <p v-else-if="!matching.rows.length" class="py-8 text-sm text-muted-foreground">{{ emptyText }}</p>
          <ul v-else class="divide-y divide-border border-y border-border">
            <li v-for="row in matching.rows" :key="matching.key(row)" class="flex items-start gap-3 py-3">
              <input
                type="checkbox"
                class="mt-2 size-4 shrink-0 accent-primary"
                :aria-label="t('tagMatching.select', { name: row.value })"
                :checked="matching.selection.includes(matching.key(row))"
                @change="matching.toggle(row)"
              />
              <button
                type="button"
                class="min-w-0 flex-1 rounded-sm text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="matching.edit(row)"
              >
                <span class="block break-words text-sm font-medium">{{
                  row.bookId ? t('tagMatching.missingFandom', { title: row.value }) : row.value
                }}</span
                ><span class="mt-1 block text-xs text-muted-foreground"
                  >{{ row.source || t('tagMatching.allSources') }} · {{ t(`tagMatching.fields.${row.field}`) }} ·
                  {{ t('tagMatching.books', { count: row.bookCount }) }}</span
                ><span v-if="row.targetNames?.length" class="mt-2 block break-words text-sm">{{ row.targetNames.join(', ') }}</span>
              </button>
              <Button variant="ghost" @click="matching.edit(row)">{{ t('common.edit') }}</Button>
            </li>
          </ul>
        </div>
        <nav class="flex items-center justify-between gap-3" :aria-label="t('tagMatching.pagination')">
          <Button variant="outline" :disabled="matching.page <= 1 || matching.loading" :aria-label="t('common.previous')" @click="matching.previous"
            ><ChevronLeft class="size-4" /></Button
          ><span class="text-sm tabular-nums">{{ matching.page }} / {{ matching.pages }}</span
          ><Button
            variant="outline"
            :disabled="matching.page >= matching.pages || matching.loading"
            :aria-label="t('common.next')"
            @click="matching.next"
            ><ChevronRight class="size-4"
          /></Button>
        </nav>
      </template>
    </template>
  </section>
</template>

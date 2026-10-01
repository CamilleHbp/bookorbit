<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import TagGroupPanel from '../components/TagGroupPanel.vue'
import type { BrowseEntityItem, DuplicateCluster } from '@bookorbit/types'

import { useEntityManager, type EntityManagerMode } from '../../composables/useEntityManager'
import { useEntityRowDensity } from '../composables/useEntityRowDensity'
import type { EntityRowDensity } from '../types'
import DuplicateReviewControls from '../components/DuplicateReviewControls.vue'
import DuplicatesPanel from '../components/DuplicatesPanel.vue'
import EntityBrowseToolbar from '../components/EntityBrowseToolbar.vue'
import EntityBrowseTable from '../components/EntityBrowseTable.vue'
import EntityTypeSelector from '../components/EntityTypeSelector.vue'
import ModeSwitcher from '../components/ModeSwitcher.vue'
import RenameModal from '../components/RenameModal.vue'
import DeleteModal from '../components/DeleteModal.vue'
import SplitModal from '../components/SplitModal.vue'
import BulkDeleteModal from '../components/BulkDeleteModal.vue'
import BrowseMergeModal from '../components/BrowseMergeModal.vue'

const props = defineProps<{ tagsOnly?: boolean }>()
const { t } = useI18n()
const { hasPermission } = usePermissions()
const canEdit = computed(() => hasPermission('library_edit_metadata'))
const em = useEntityManager(props.tagsOnly ? 'tag' : 'author')
const groupRevision = ref(0)
const toolbar = ref<HTMLElement | null>(null)
const hasTagFilter = computed(() => em.entityType.value === 'tag' && em.tagPrefix.value !== undefined)
const tagFilterLabel = computed(() => em.tagPrefix.value || t('tools.tagManager.ungrouped'))

function handleClearTagFilter(): void {
  em.tagPrefix.value = undefined
  em.clearSelection()
  refreshBrowseFromFirstPage()
}

function handleTagFilter(separator: string | undefined, prefix: string | undefined): void {
  const changed = em.tagPrefix.value !== prefix || (prefix !== undefined && em.tagSeparator.value !== separator)
  em.tagSeparator.value = separator
  em.tagPrefix.value = prefix
  if (!changed) return
  em.clearSelection()
  refreshBrowseFromFirstPage()
}
const { density } = useEntityRowDensity()

const renameTarget = ref<BrowseEntityItem | null>(null)
const deleteTarget = ref<BrowseEntityItem | null>(null)
const splitTarget = ref<BrowseEntityItem | null>(null)
const showBulkDelete = ref(false)
const showBrowseMerge = ref(false)

const selectedBrowseItems = computed(() => Array.from(em.selectedItemsMap.value.values()))
const hasActiveFilters = computed(() => em.browseSearch.value.length > 0 || em.browseBookCount.value === 'empty' || hasTagFilter.value)
const deleteDefaultMode = computed<'soft' | 'hard'>(() => (deleteTarget.value?.bookCount === 0 ? 'hard' : 'soft'))
const bulkDeleteDefaultMode = computed<'soft' | 'hard'>(() =>
  selectedBrowseItems.value.length > 0 && selectedBrowseItems.value.every((item) => item.bookCount === 0) ? 'hard' : 'soft',
)

let searchDebounce: ReturnType<typeof setTimeout> | null = null
let skipNextSearchWatch = false
onUnmounted(() => {
  if (searchDebounce) clearTimeout(searchDebounce)
})

function refreshBrowseFromFirstPage(): void {
  em.browsePage.value = 1
  em.fetchBrowse()
}

watch(em.browseSearch, () => {
  if (skipNextSearchWatch) {
    skipNextSearchWatch = false
    return
  }
  if (searchDebounce) clearTimeout(searchDebounce)
  searchDebounce = setTimeout(() => {
    refreshBrowseFromFirstPage()
  }, 300)
})

watch(
  [em.mode, em.entityType],
  ([newMode]) => {
    if (!canEdit.value) return
    if (newMode === 'browse') {
      em.fetchBrowse()
    } else if (newMode === 'duplicates') {
      em.fetchScanStatus()
      runScan()
    }
  },
  { immediate: true },
)

function handleUpdateMode(value: EntityManagerMode): void {
  em.mode.value = value
}

function runScan(): void {
  em.scanPage.value = 1
  em.scan()
}

function handleUpdateMinSimilarity(value: number): void {
  em.minSimilarity.value = value
  runScan()
}

function handleRefreshDuplicates(): void {
  em.refreshDuplicates()
}

function handleScanPage(value: number): void {
  em.scanPage.value = value
  em.scan()
}

async function handleDismissCluster(cluster: DuplicateCluster): Promise<void> {
  for (const pair of cluster.pairDetails) {
    await em.dismissPair(pair.idA, pair.idB)
  }
  em.removeClustersByIds(cluster.entities.map((entity) => entity.id))
}

function handleUpdateSearch(value: string): void {
  em.browseSearch.value = value
}

function handleUpdatePage(value: number): void {
  em.browsePage.value = value
  em.fetchBrowse()
}

function handleUpdatePageSize(value: number): void {
  em.browsePageSize.value = value
  refreshBrowseFromFirstPage()
}

function handleUpdateDensity(value: EntityRowDensity): void {
  density.value = value
}

function handleToggleAll(selected: boolean): void {
  em.setSelection(
    em.browseItems.value.map((item) => item.id),
    selected,
  )
}

function handleClearFilters(): void {
  if (searchDebounce) {
    clearTimeout(searchDebounce)
    searchDebounce = null
  }
  if (em.browseSearch.value !== '') skipNextSearchWatch = true
  em.browseSearch.value = ''
  em.browseBookCount.value = 'any'
  em.tagPrefix.value = undefined
  em.clearSelection()
  refreshBrowseFromFirstPage()
}

function handleBrowseSortChange(sortBy: 'name' | 'bookCount', sortOrder: 'asc' | 'desc'): void {
  em.browseSortBy.value = sortBy
  em.browseSortOrder.value = sortOrder
  refreshBrowseFromFirstPage()
}

function handleUpdateBookCount(value: 'any' | 'empty'): void {
  em.browseBookCount.value = em.isInline.value ? 'any' : value
  refreshBrowseFromFirstPage()
}

async function handleMerge(targetId: number | string, sourceIds: (number | string)[], writeFiles: boolean): Promise<void> {
  try {
    await em.mergeEntities(targetId, sourceIds, writeFiles)
  } catch {
    return
  }
  em.removeClustersByIds(sourceIds)
}

async function handleDismissEntity(cluster: DuplicateCluster, entityId: number | string): Promise<void> {
  const pairs = cluster.pairDetails.filter((p) => p.idA === entityId || p.idB === entityId)
  for (const pair of pairs) {
    await em.dismissPair(pair.idA, pair.idB)
  }
  em.removeClustersByIds([entityId])
}

async function handleDismissPair(idA: number | string, idB: number | string): Promise<void> {
  await em.dismissPair(idA, idB)
  em.removePairFromClusters(idA, idB)
}

async function handleUndismiss(idA: number | string, idB: number | string): Promise<void> {
  await em.undismissPair(idA, idB)
  if (em.clusters.value.length > 0) {
    em.scan()
  }
}

function handleToggleDismissed(): void {
  em.showDismissed.value = !em.showDismissed.value
}

function handleSelectItem(id: number | string, event: MouseEvent): void {
  if (event.shiftKey) {
    em.rangeSelectTo(id)
    return
  }
  em.toggleSelection(id)
}

function handleRename(item: BrowseEntityItem): void {
  em.operationError.value = null
  renameTarget.value = item
}

function handleDelete(item: BrowseEntityItem): void {
  em.operationError.value = null
  deleteTarget.value = item
}

function handleSplit(item: BrowseEntityItem): void {
  em.operationError.value = null
  splitTarget.value = item
}

function handleBulkDelete(): void {
  em.operationError.value = null
  showBulkDelete.value = true
}

function handleBulkMerge(): void {
  em.operationError.value = null
  showBrowseMerge.value = true
}

async function handleBrowseMergeConfirm(targetId: number | string, sourceIds: (number | string)[], writeFiles: boolean): Promise<void> {
  try {
    await em.mergeEntities(targetId, sourceIds, writeFiles)
  } catch {
    return
  }
  showBrowseMerge.value = false
  em.clearSelection()
  em.fetchBrowse()
  groupRevision.value += 1
}

async function handleRenameConfirm(newName: string, writeFiles: boolean): Promise<void> {
  if (!renameTarget.value) return
  try {
    await em.renameEntity(renameTarget.value.id, newName, writeFiles)
  } catch {
    return
  }
  renameTarget.value = null
  em.fetchBrowse()
  groupRevision.value += 1
}

async function handleDeleteConfirm(mode: 'soft' | 'hard' | 'inline', writeFiles: boolean): Promise<void> {
  if (!deleteTarget.value) return
  const id = deleteTarget.value.id
  try {
    await em.deleteEntity(id, mode, writeFiles)
  } catch {
    return
  }
  em.removeFromSelection(id)
  deleteTarget.value = null
  em.fetchBrowse()
  groupRevision.value += 1
}

async function handleSplitConfirm(newNames: string[], writeFiles: boolean): Promise<void> {
  if (!splitTarget.value) return
  const id = splitTarget.value.id
  try {
    await em.splitEntity(id as number, newNames, writeFiles)
  } catch {
    return
  }
  em.removeFromSelection(id)
  splitTarget.value = null
  em.fetchBrowse()
  groupRevision.value += 1
}

async function handleBulkDeleteConfirm(mode: 'soft' | 'hard' | 'inline', writeFiles: boolean): Promise<void> {
  const ids = Array.from(em.selectedIds.value)
  try {
    await em.bulkDeleteEntities(ids, mode, writeFiles)
  } catch {
    return
  }
  showBulkDelete.value = false
  em.clearSelection()
  em.fetchBrowse()
  groupRevision.value += 1
}
</script>

<template>
  <p v-if="!canEdit" role="alert" class="p-4 text-sm text-muted-foreground">{{ t('tools.tagManager.permissionRequired') }}</p>
  <div v-else class="flex flex-col h-full overflow-hidden">
    <div
      ref="toolbar"
      tabindex="-1"
      class="flex flex-none flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-border bg-card px-2.5 py-2"
    >
      <h1 v-if="tagsOnly" class="px-2 text-base font-semibold">{{ t('tools.header.tags') }}</h1>
      <EntityTypeSelector v-else v-model="em.entityType.value" />
      <span class="hidden h-5 w-px shrink-0 bg-border sm:block" aria-hidden="true" />
      <ModeSwitcher :model-value="em.mode.value" @update:model-value="handleUpdateMode" />
      <span class="hidden h-5 w-px shrink-0 bg-border sm:block" aria-hidden="true" />

      <EntityBrowseToolbar
        v-if="em.mode.value === 'browse'"
        :tags-only="em.entityType.value === 'tag'"
        :search="em.browseSearch.value"
        :book-count="em.browseBookCount.value"
        :total="em.browseTotal.value"
        :density="density"
        :selected-count="em.selectedIds.value.size"
        :is-inline="em.isInline.value"
        @update:search="handleUpdateSearch"
        @update:book-count="handleUpdateBookCount"
        @update:density="handleUpdateDensity"
        @bulk-merge="handleBulkMerge"
        @bulk-delete="handleBulkDelete"
        @clear-selection="em.clearSelection"
      />
      <DuplicateReviewControls
        v-else
        :total="em.scanTotal.value"
        :scanning="em.scanning.value"
        :scan-status="em.duplicateScanStatus.value"
        :min-similarity="em.minSimilarity.value"
        :is-inline="em.isInline.value"
        @update:min-similarity="handleUpdateMinSimilarity"
        @recompute="handleRefreshDuplicates"
      />
    </div>

    <!-- Duplicates mode -->
    <div v-if="em.mode.value === 'duplicates'" class="flex-1 min-h-0 overflow-hidden pt-3">
      <DuplicatesPanel
        :clusters="em.clusters.value"
        :page="em.scanPage.value"
        :total-pages="em.scanTotalPages.value"
        :scanning="em.scanning.value"
        :has-scanned="em.hasScanned.value"
        :scan-error="em.scanError.value"
        :operation-loading="em.operationLoading.value"
        :dismissed-pairs="em.dismissedPairs.value"
        :dismissed-loading="em.dismissedLoading.value"
        :show-dismissed="em.showDismissed.value"
        @update:page="handleScanPage"
        @merge="handleMerge"
        @dismiss-entity="handleDismissEntity"
        @dismiss-pair="handleDismissPair"
        @dismiss-cluster="handleDismissCluster"
        @undismiss="handleUndismiss"
        @toggle-dismissed="handleToggleDismissed"
      />
    </div>

    <!-- Browse mode: the data grid owns its own scroll so the header can stick -->
    <div v-if="em.mode.value === 'browse'" class="flex flex-1 min-h-0 flex-col gap-3 overflow-hidden pt-3 md:flex-row">
      <TagGroupPanel v-if="em.entityType.value === 'tag'" :revision="groupRevision" :prefix="em.tagPrefix.value" @filter="handleTagFilter" />
      <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <div v-if="hasTagFilter" class="flex min-h-9 items-center justify-between gap-3 text-sm">
          <p class="min-w-0 break-words font-medium">{{ t('tools.tagManager.activeGroup', { group: tagFilterLabel }) }}</p>
          <button
            type="button"
            class="shrink-0 rounded-md px-2 py-1 text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            @click="handleClearTagFilter"
          >
            {{ t('tools.tagManager.allTags') }}
          </button>
        </div>
        <div v-if="em.browseError.value" role="alert" class="flex flex-1 flex-col items-center justify-center gap-3 text-sm">
          <p>{{ t('tools.tagManager.browseError') }}</p>
          <button type="button" class="text-primary underline underline-offset-4" @click="em.fetchBrowse">{{ t('common.retry') }}</button>
        </div>
        <EntityBrowseTable
          v-else
          class="min-h-0 min-w-0 flex-1"
          :items="em.browseItems.value"
          :total="em.browseTotal.value"
          :page="em.browsePage.value"
          :page-size="em.browsePageSize.value"
          :total-pages="em.browseTotalPages.value"
          :sort-by="em.browseSortBy.value"
          :sort-order="em.browseSortOrder.value"
          :density="density"
          :loading="em.browseLoading.value"
          :has-active-filters="hasActiveFilters"
          :selected-ids="em.selectedIds.value"
          :capabilities="em.capabilities.value"
          :is-inline="em.isInline.value"
          @update:page="handleUpdatePage"
          @update:page-size="handleUpdatePageSize"
          @sort-change="handleBrowseSortChange"
          @select="handleSelectItem"
          @toggle-all="handleToggleAll"
          @rename="handleRename"
          @delete="handleDelete"
          @split="handleSplit"
          @clear-filters="handleClearFilters"
        />
      </div>
    </div>

    <p v-if="em.operationError.value && !renameTarget" role="alert" class="py-2 text-sm text-destructive">
      {{ t('tools.tagManager.operationError') }}
    </p>

    <!-- Modals -->
    <RenameModal
      v-if="renameTarget"
      :current-name="renameTarget.name"
      :fallback-focus="toolbar"
      :max-length="em.entityType.value === 'tag' ? 200 : undefined"
      :error="em.operationError.value ? t('tools.tagManager.operationError') : undefined"
      :loading="em.operationLoading.value"
      @confirm="handleRenameConfirm"
      @cancel="renameTarget = null"
    />

    <DeleteModal
      :error="em.operationError.value ? t('tools.tagManager.operationError') : undefined"
      v-if="deleteTarget"
      :entity-name="deleteTarget.name"
      :is-inline="em.isInline.value"
      :default-mode="deleteDefaultMode"
      :loading="em.operationLoading.value"
      @confirm="handleDeleteConfirm"
      @cancel="deleteTarget = null"
    />

    <SplitModal
      :error="em.operationError.value ? t('tools.tagManager.operationError') : undefined"
      v-if="splitTarget"
      :entity-name="splitTarget.name"
      :loading="em.operationLoading.value"
      @confirm="handleSplitConfirm"
      @cancel="splitTarget = null"
    />

    <BulkDeleteModal
      :error="em.operationError.value ? t('tools.tagManager.operationError') : undefined"
      v-if="showBulkDelete"
      :count="em.selectedIds.value.size"
      :is-inline="em.isInline.value"
      :default-mode="bulkDeleteDefaultMode"
      :loading="em.operationLoading.value"
      @confirm="handleBulkDeleteConfirm"
      @cancel="showBulkDelete = false"
    />

    <BrowseMergeModal
      :error="em.operationError.value ? t('tools.tagManager.operationError') : undefined"
      v-if="showBrowseMerge"
      :items="selectedBrowseItems"
      :loading="em.operationLoading.value"
      @confirm="handleBrowseMergeConfirm"
      @cancel="showBrowseMerge = false"
    />
  </div>
</template>

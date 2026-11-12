<script setup lang="ts">
import type { FanfictionChapterChanges } from '@bookorbit/types'
import { useI18n } from 'vue-i18n'
defineProps<{ changes?: FanfictionChapterChanges }>()
const { t } = useI18n()
</script>
<template>
  <p v-if="changes?.incompletePreview" role="alert">{{ t('fanfiction.errors.access_denied') }}</p>
  <details v-if="changes?.differences?.length">
    <summary class="cursor-pointer">{{ t('settings.admin.libraries.viewChanges') }}</summary>
    <div class="mt-2 max-h-80 overflow-auto">
      <table class="w-full table-fixed text-start text-sm">
        <thead>
          <tr>
            <th class="text-start">{{ t('fanfiction.metadataReview.current') }}</th>
            <th class="text-start">{{ t('fanfiction.sourceReview.remoteBook') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(diff, i) in changes.differences" :key="i" class="border-t align-top">
            <td v-for="(side, j) in [diff.saved, diff.website]" :key="j" class="p-2 break-words">
              <template v-if="side"
                ><strong>{{ side.position }}. {{ side.title }}</strong>
                <p v-if="side.excerpt" class="mt-1">{{ side.excerpt }}</p></template
              >
              <span v-else>∅</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </details>
</template>

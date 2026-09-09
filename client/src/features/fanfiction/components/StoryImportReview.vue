<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FanfictionJob } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { useImportReview } from '../composables/useImportReview'
const props = defineProps<{ job: FanfictionJob; disabled?: boolean }>()
const emit = defineEmits<{ updated: [job: FanfictionJob] }>()
const { t } = useI18n()
const { values, busy, error, deferred, apply, later, discard, resume } = useImportReview(
  () => props.job,
  (job) => emit('updated', job),
)
const authors = computed({
  get: () => values.value.authors.join('\n'),
  set: (value) => {
    values.value.authors = value
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean)
  },
})
const tags = computed({
  get: () => values.value.tags.join(', '),
  set: (value) => {
    values.value.tags = value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
  },
})
</script>
<template>
  <Button v-if="deferred" @click="resume">{{ t('fanfiction.previewStory') }}</Button>
  <form v-else class="space-y-3 border-border rounded-lg border p-4 w-full" @submit.prevent="apply">
    <h3 class="font-semibold">{{ t('fanfiction.previewStory') }}</h3>
    <p class="text-sm text-muted-foreground">{{ t('fanfiction.metadataReview.importHelp') }}</p>
    <label class="block text-sm"
      >{{ t('fanfiction.storyTitle')
      }}<input
        v-model="values.title"
        required
        maxlength="500"
        class="border-input bg-background mt-1 w-full rounded border p-2"
        :disabled="busy || disabled"
    /></label>
    <label class="block text-sm"
      >{{ t('fanfiction.storyAuthors')
      }}<textarea v-model="authors" class="border-input bg-background mt-1 w-full rounded border p-2" :disabled="busy || disabled" />
    </label>
    <label class="block text-sm"
      >{{ t('fanfiction.storyDescription')
      }}<textarea
        v-model="values.description"
        rows="4"
        maxlength="262144"
        class="border-input bg-background mt-1 w-full rounded border p-2"
        :disabled="busy || disabled"
      />
    </label>
    <label class="block text-sm"
      >{{ t('fanfiction.storyTags')
      }}<textarea v-model="tags" rows="3" class="border-input bg-background mt-1 w-full rounded border p-2" :disabled="busy || disabled" />
    </label>
    <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
    <div class="flex flex-wrap gap-2">
      <Button type="submit" :disabled="busy || disabled">{{ t('fanfiction.confirmImport') }}</Button>
      <Button type="button" variant="outline" :disabled="busy || disabled" @click="later">{{ t('fanfiction.metadataReview.later') }}</Button>
      <Button type="button" variant="ghost" :disabled="busy || disabled" @click="discard">{{ t('fanfiction.metadataReview.discardImport') }}</Button>
    </div>
  </form>
</template>

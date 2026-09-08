<script setup lang="ts">
import { ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FanfictionMetadataEdits, FanfictionPreview } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { useModal } from '@/composables/useModal'
import { useStoryPreview } from '../composables/useStoryPreview'

const props = defineProps<{ preview: FanfictionPreview; busy: boolean; locked: boolean; error: string }>()
const emit = defineEmits<{ confirm: [metadata: FanfictionMetadataEdits]; cancel: [] }>()
const { t } = useI18n()
const panel = ref<HTMLElement | null>(null)
const headingId = useId()
const { title, authors, description, tags, editing, valid, edit, changes, plainDescription, visibleTags, remainingTags } = useStoryPreview(
  props.preview,
)
function cancel() {
  if (!props.busy) emit('cancel')
}
function confirm() {
  if (!props.busy && valid.value) emit('confirm', changes())
}
useModal({ container: panel, onClose: cancel })
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50 p-3 sm:p-6">
      <section
        ref="panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="headingId"
        tabindex="-1"
        class="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl"
      >
        <header class="border-b border-border p-4 sm:p-6">
          <h2 :id="headingId" class="text-lg font-semibold">{{ t('fanfiction.previewStory') }}</h2>
          <p class="text-sm text-muted-foreground">
            {{ preview.site }} · {{ t('fanfiction.chapterCount', { count: preview.chapterCount })
            }}<span v-if="preview.wordCount !== null"> · {{ t('fanfiction.wordCount', { count: preview.wordCount }) }}</span>
          </p>
        </header>
        <form class="flex min-h-0 flex-col" @submit.prevent="confirm">
          <div class="space-y-4 overflow-y-auto p-4 sm:p-6">
            <fieldset v-if="editing" :disabled="busy || locked" class="space-y-4">
              <label class="block space-y-1 text-sm"
                >{{ t('fanfiction.storyTitle')
                }}<input v-model="title" required maxlength="500" class="block w-full rounded-md border border-input bg-background p-2"
              /></label>
              <label class="block space-y-1 text-sm"
                >{{ t('fanfiction.storyAuthors')
                }}<textarea v-model="authors" rows="2" maxlength="50100" class="block w-full rounded-md border border-input bg-background p-2" />
              </label>
              <label class="block space-y-1 text-sm"
                >{{ t('fanfiction.storyDescription')
                }}<textarea v-model="description" rows="5" maxlength="65536" class="block w-full rounded-md border border-input bg-background p-2" />
              </label>
              <label class="block space-y-1 text-sm"
                >{{ t('fanfiction.storyTags')
                }}<textarea v-model="tags" rows="3" maxlength="501000" class="block w-full rounded-md border border-input bg-background p-2" />
              </label>
              <p v-if="!valid" class="text-sm text-destructive">{{ t('fanfiction.invalidStoryDetails') }}</p>
            </fieldset>
            <template v-else>
              <div>
                <h3 class="break-words text-xl font-semibold">{{ preview.title }}</h3>
                <p class="text-muted-foreground">{{ preview.authors.join(', ') }}</p>
              </div>
              <p class="whitespace-pre-line break-words text-sm">{{ plainDescription }}</p>
              <div class="flex flex-wrap gap-2">
                <span v-for="tag in visibleTags" :key="tag" class="rounded-md bg-muted px-2 py-1 text-xs">{{ tag }}</span
                ><span v-if="remainingTags" class="text-sm text-muted-foreground">+{{ remainingTags }}</span>
              </div>
            </template>
            <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
          </div>
          <footer class="flex flex-wrap justify-end gap-2 border-t border-border p-4">
            <Button type="button" variant="outline" :disabled="busy" @click="cancel">{{ t('fanfiction.cancel') }}</Button>
            <Button v-if="!editing && !locked" type="button" variant="outline" :disabled="busy" @click="edit">{{
              t('fanfiction.editStoryData')
            }}</Button>
            <Button type="submit" :disabled="busy || !valid">{{
              t(locked && error ? 'fanfiction.retryConfirmedImport' : 'fanfiction.confirmImport')
            }}</Button>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>

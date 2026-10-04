<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSafeHtml } from '@/features/book/composables/useSafeHtml'

const props = defineProps<{ description: string | undefined }>()
const { t } = useI18n()
const sanitizedDescription = useSafeHtml(() => props.description)
const safeDescription = computed(() => sanitizedDescription.value.trim())
// Source HTML indentation is layout whitespace, while plain-text line breaks carry meaning.
const whitespaceClass = computed(() => (/<[a-z][^>]*>/i.test(safeDescription.value) ? 'whitespace-normal' : 'whitespace-pre-wrap'))
</script>

<template>
  <div
    data-test="story-description"
    :class="whitespaceClass"
    class="max-h-48 overflow-auto break-words text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5"
  >
    <!-- eslint-disable-next-line vue/no-v-html -- sanitized by useSafeHtml -->
    <div v-if="safeDescription" class="[&>:first-child]:mt-0 [&>:last-child]:mb-0" v-html="safeDescription" />
    <p v-else>{{ t('fanfiction.metadataReview.empty') }}</p>
  </div>
</template>

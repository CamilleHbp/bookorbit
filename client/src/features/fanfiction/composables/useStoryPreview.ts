import { computed, ref } from 'vue'
import type { FanfictionMetadataEdits, FanfictionPreview } from '@bookorbit/types'

export function useStoryPreview(preview: FanfictionPreview) {
  const document = new DOMParser().parseFromString(preview.description, 'text/html')
  document.querySelectorAll('br').forEach((element) => element.replaceWith('\n'))
  document.querySelectorAll('p, div').forEach((element) => element.append('\n'))
  const plainDescription = document.body.textContent?.trim() ?? ''
  const title = ref(preview.title)
  const authors = ref(preview.authors.join('\n'))
  const description = ref(plainDescription)
  const tags = ref([...preview.tags])
  const editing = ref(false)
  const entries = (value: string) => [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ]
  const parsedAuthors = computed(() => entries(authors.value))
  const parsedTags = computed(() => [...new Set(tags.value.map((tag) => tag.trim()).filter(Boolean))])
  const visibleTags = preview.tags.slice(0, 20)
  const remainingTags = Math.max(0, preview.tags.length - visibleTags.length)
  const valid = computed(
    () =>
      !!title.value.trim() &&
      title.value.trim().length <= 500 &&
      (description.value === plainDescription || description.value.length <= 65536) &&
      parsedAuthors.value.length <= 100 &&
      parsedTags.value.length <= 1000 &&
      [...parsedAuthors.value, ...parsedTags.value].every((entry) => entry.length <= 500),
  )
  function edit() {
    editing.value = true
  }
  function changes(): FanfictionMetadataEdits {
    return {
      ...(title.value.trim() !== preview.title ? { title: title.value.trim() } : {}),
      ...(authors.value !== preview.authors.join('\n') ? { authors: parsedAuthors.value } : {}),
      ...(description.value !== plainDescription ? { description: description.value } : {}),
      ...(JSON.stringify(parsedTags.value) !== JSON.stringify(preview.tags) ? { tags: parsedTags.value } : {}),
    }
  }
  return { title, authors, description, tags, editing, valid, edit, changes, plainDescription, visibleTags, remainingTags }
}

import { computed, ref, shallowRef, watch, type Ref } from 'vue'
import type { FanfictionMetadataChoices, FanfictionMetadataField, FanfictionMetadataReview, FanfictionMetadataValues } from '@bookorbit/types'

export function useStoryMetadataReview(review: Ref<FanfictionMetadataReview>, choices: Ref<FanfictionMetadataChoices>) {
  // Saving can commit several chip fields before the parent renders the new model value.
  const draft = shallowRef(choices.value)
  watch(choices, (value) => {
    draft.value = value
  })

  function saveDraft(value: FanfictionMetadataChoices) {
    draft.value = value
    choices.value = value
  }

  const inputVersions = ref<Record<FanfictionMetadataField, number>>({ title: 0, authors: 0, description: 0, genres: 0, tags: 0 })
  const finalValues = computed<FanfictionMetadataValues>(() => {
    const result = { ...review.value.current }
    for (const field of ['title', 'authors', 'description', 'genres'] as const) {
      const mode = draft.value[field]
      if (mode === 'incoming') Object.assign(result, { [field]: review.value.incoming[field] })
      else if (mode === 'edit') Object.assign(result, { [field]: draft.value.values?.[field] ?? result[field] })
    }
    if (draft.value.tags === 'merge') result.tags = [...new Set([...result.tags, ...review.value.incoming.tags])]
    else if (draft.value.tags === 'select') {
      // Restore older drafts that selected source tags separately from personal tags.
      result.tags = [...new Set([...(review.value.tags?.custom ?? []), ...(draft.value.selectedTags ?? review.value.incoming.tags)])]
    } else if (draft.value.tags === 'edit') result.tags = draft.value.selectedTags ?? review.value.incoming.tags
    return result
  })

  function updateField<K extends FanfictionMetadataField>(field: K, value: FanfictionMetadataValues[K]) {
    saveDraft({
      ...draft.value,
      [field]: 'edit',
      values: { ...finalValues.value, [field]: value },
      ...(field === 'tags' ? { selectedTags: value as string[] } : {}),
      keepAll: false,
    })
  }

  function chooseSource(field: FanfictionMetadataField, source: 'current' | 'incoming') {
    const value = review.value[source][field] ?? (field === 'genres' ? [] : '')
    saveDraft({
      ...draft.value,
      [field]: source === 'current' ? 'keep' : field === 'tags' ? 'edit' : 'incoming',
      values: { ...finalValues.value, [field]: Array.isArray(value) ? [...value] : value },
      ...(field === 'tags' ? { selectedTags: [...review.value[source].tags] } : {}),
      keepAll: false,
    })
    // Discard uncommitted chip text as well when replacing the final value from a source.
    inputVersions.value[field]++
  }

  function combine(field: 'authors' | 'genres' | 'tags') {
    updateField(field, [...new Set([...(review.value.current[field] ?? []), ...(review.value.incoming[field] ?? [])])])
    inputVersions.value[field]++
  }

  return { finalValues, inputVersions, updateField, chooseSource, combine }
}

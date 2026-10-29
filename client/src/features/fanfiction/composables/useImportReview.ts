import { ref, watch, type MaybeRefOrGetter, toValue } from 'vue'
import type { FanfictionJob, FanfictionMetadataValues } from '@bookorbit/types'
import { api } from '@/lib/api'

export function useImportReview(job: MaybeRefOrGetter<FanfictionJob>, updated: (job: FanfictionJob) => void) {
  const values = ref<FanfictionMetadataValues>({ title: '', description: '', authors: [], tags: [] })
  const busy = ref(false)
  const error = ref('')
  const deferred = ref(false)
  watch(
    () => toValue(job).id,
    () => {
      const review = toValue(job).result?.importReview
      if (review) values.value = JSON.parse(JSON.stringify(review.values))
    },
    { immediate: true },
  )
  async function decide(action: 'apply' | 'later' | 'discard') {
    if (busy.value) return
    busy.value = true
    error.value = ''
    const current = toValue(job)
    try {
      const response = await api(`/api/v1/libraries/${current.libraryId}/fanfiction/jobs/${current.id}/import-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, values: values.value }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message ?? 'Could not save the import review')
      if (toValue(job).id !== current.id) return
      deferred.value = action === 'later'
      updated(result)
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : 'Could not save the import review'
    } finally {
      busy.value = false
    }
  }
  return {
    values,
    busy,
    error,
    deferred,
    apply: () => decide('apply'),
    later: () => decide('later'),
    discard: () => decide('discard'),
    resume: () => {
      deferred.value = false
    },
  }
}

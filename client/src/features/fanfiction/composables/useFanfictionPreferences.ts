import { ref } from 'vue'
import type { FanfictionPreferences } from '@bookorbit/types'
import { api } from '@/lib/api'

export function useFanfictionPreferences() {
  const isAdult = ref(false)
  const defaultUpdatePolicy = ref<'safe' | 'review'>('safe')
  const busy = ref(false)
  const error = ref('')
  async function request(value?: Partial<FanfictionPreferences>) {
    busy.value = true
    error.value = ''
    try {
      const response = await api(
        '/api/v1/fanfiction/preferences',
        value === undefined
          ? undefined
          : {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(value),
            },
      )
      if (!response.ok) throw new Error('Could not save story preferences. Try again.')
      const result = (await response.json()) as FanfictionPreferences
      isAdult.value = result.isAdult
      defaultUpdatePolicy.value = result.defaultUpdatePolicy ?? 'safe'
      return true
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : 'Request failed'
      return false
    } finally {
      busy.value = false
    }
  }
  const load = () => request()
  const save = () => request({ defaultUpdatePolicy: defaultUpdatePolicy.value })
  const allowAdult = () => request({ isAdult: true })
  return { isAdult, defaultUpdatePolicy, busy, error, load, save, allowAdult }
}

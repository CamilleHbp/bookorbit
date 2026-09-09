import { ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { BookDetail, UpdateSensitiveCoverRequest } from '@bookorbit/types'
import { api } from '@/lib/api'
import { useCoverVersions } from './useCoverVersions'

export function useSensitiveCoverSetting(book: Ref<BookDetail>) {
  const { t } = useI18n()
  const { bumpVersion } = useCoverVersions()
  const sensitiveCover = ref(book.value.sensitiveCover === true)
  const savingSensitiveCover = ref(false)
  watch(
    () => [book.value.id, book.value.sensitiveCover],
    () => {
      sensitiveCover.value = book.value.sensitiveCover === true
    },
  )
  async function saveSensitiveCover(value: boolean): Promise<boolean> {
    if (savingSensitiveCover.value) return false
    const bookId = book.value.id
    savingSensitiveCover.value = true
    try {
      const body: UpdateSensitiveCoverRequest = { sensitiveCover: value }
      const response = await api(`/api/v1/books/${bookId}/sensitive-cover`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      bumpVersion(bookId)
      if (book.value.id !== bookId) return false
      sensitiveCover.value = value
      return true
    } catch {
      toast.error(t('book.sensitiveCover.saveError'))
      return false
    } finally {
      savingSensitiveCover.value = false
    }
  }
  return { sensitiveCover, savingSensitiveCover, saveSensitiveCover }
}

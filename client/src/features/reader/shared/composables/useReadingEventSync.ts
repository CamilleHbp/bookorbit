import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { ReadingAnchor, ReadingEventReceipt } from '@bookorbit/types'
import { readReadingEventReceipt, sendStoredReadingEvent, sendUnstoredReadingEvent } from './reading-event-transport'
import { readingEventOutbox } from './reading-event-outbox'
import { holdReadingEventLock } from './reading-event-lock'

export function useReadingEventSync(fileId: number, userId: MaybeRefOrGetter<number | null>, receive: (receipt: ReadingEventReceipt) => void) {
  const storageError = ref('')
  const transferError = ref('')
  const error = computed(() => storageError.value || transferError.value)
  const pending = ref(false)
  let generation = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let active: Promise<void> | null = null
  let activeOwner: number | null = null
  let failures = 0
  let blocked = false
  let readerLock = toValue(userId) ? holdReadingEventLock(toValue(userId)!, fileId) : null

  function schedule() {
    clearTimeout(timer)
    if (disposed || blocked || failures >= 5 || !navigator.onLine || !pending.value) return
    timer = setTimeout(
      () => {
        void flush()
      },
      Math.min(60_000, 3000 * 2 ** failures),
    )
  }

  async function persist(owner: number, libraryId: number, anchor: ReadingAnchor) {
    try {
      await readingEventOutbox.put(owner, libraryId, fileId, anchor)
      if (!disposed && toValue(userId) === owner) {
        pending.value = true
        storageError.value = ''
      }
    } catch (failure) {
      if (!disposed && toValue(userId) === owner)
        storageError.value = failure instanceof Error ? failure.message : 'Reading position could not be saved offline'
      throw failure
    }
  }

  async function sendUnstored(owner: number, libraryId: number, anchor: ReadingAnchor) {
    if (disposed || toValue(userId) !== owner || !navigator.onLine) return
    const current = generation
    try {
      const response = await sendUnstoredReadingEvent(owner, libraryId, fileId, anchor, AbortSignal.timeout(15_000))
      if (disposed || generation !== current || toValue(userId) !== owner) return
      if (!response.ok) throw new Error('Reading synchronization could not finish')
      const receipt = await readReadingEventReceipt(response)
      receive(receipt)
    } catch (failure) {
      if (!disposed && generation === current && toValue(userId) === owner)
        transferError.value = failure instanceof Error ? failure.message : 'Reading synchronization could not finish'
    }
  }

  async function flush(): Promise<void> {
    if (active) {
      if (activeOwner === toValue(userId)) return active
      await active
      return flush()
    }
    const owner = toValue(userId)
    if (!owner || disposed || blocked || !navigator.onLine) return
    const current = generation
    activeOwner = owner
    const valid = () => !disposed && generation === current && toValue(userId) === owner
    const abort = new AbortController()
    controller = abort
    const timeout = setTimeout(() => abort.abort(), 15_000)
    active = (async () => {
      try {
        await readerLock?.ready
        if (!valid()) return
        const events = await readingEventOutbox.pending(owner, fileId)
        for (const event of events) {
          if (!valid()) return
          const response = await sendStoredReadingEvent(event, abort.signal)
          if (!valid()) return
          if (!response.ok) {
            blocked = [400, 401, 403, 404, 409, 422].includes(response.status)
            throw new Error('Reading position is saved on this device. Synchronization could not finish.')
          }
          const receipt = await readReadingEventReceipt(response)
          await readingEventOutbox.remove(owner, event.request.anchor.event!.id)
          if (!valid()) return
          receive(receipt)
        }
        if (!valid()) return
        pending.value = (await readingEventOutbox.pending(owner, fileId, 1)).length > 0
        transferError.value = ''
        failures = 0
      } catch (failure) {
        if (valid()) {
          pending.value = true
          transferError.value = failure instanceof Error ? failure.message : 'Reading synchronization could not finish'
          failures++
        }
      } finally {
        clearTimeout(timeout)
        if (controller === abort) controller = undefined
        active = null
        if (valid()) schedule()
      }
    })()
    return active
  }

  function retry() {
    failures = 0
    blocked = false
    return flush()
  }
  function reconnect() {
    if (!navigator.onLine || blocked) return
    failures = 0
    void flush()
  }
  watch(
    () => toValue(userId),
    () => {
      generation++
      readerLock?.release()
      readerLock = toValue(userId) ? holdReadingEventLock(toValue(userId)!, fileId) : null
      controller?.abort()
      clearTimeout(timer)
      failures = 0
      blocked = false
      pending.value = false
      transferError.value = ''
      storageError.value = ''
    },
  )
  window.addEventListener('online', reconnect)
  onScopeDispose(() => {
    disposed = true
    generation++
    readerLock?.release()
    controller?.abort()
    clearTimeout(timer)
    window.removeEventListener('online', reconnect)
  })
  return { error, pending, persist, flush, retry, sendUnstored }
}

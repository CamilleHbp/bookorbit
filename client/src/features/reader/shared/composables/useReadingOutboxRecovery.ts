import { onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { api } from '@/lib/api'
import type { ReadingEventReceipt } from '@bookorbit/types'
import { readingEventOutbox } from './reading-event-outbox'
import { readingEventLockName } from './reading-event-lock'

export function useReadingOutboxRecovery(userId: MaybeRefOrGetter<number | null>) {
  const error = ref('')
  const blockedFiles = new Set<number>()
  let disposed = false
  let generation = 0
  let failures = 0
  let active: Promise<void> | null = null
  let activeOwner: number | null = null
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function schedule(delay = 60_000) {
    clearTimeout(timer)
    if (disposed || !toValue(userId) || !navigator.locks || !navigator.onLine || document.hidden || failures >= 5) return
    timer = setTimeout(() => {
      void flush()
    }, delay)
  }

  async function flush(): Promise<void> {
    if (active) {
      if (activeOwner === toValue(userId)) return active
      await active
      return flush()
    }
    const owner = toValue(userId)
    if (!owner || disposed || !navigator.locks || !navigator.onLine || document.hidden || failures >= 5) return
    const current = generation
    activeOwner = owner
    const valid = () => !disposed && current === generation && toValue(userId) === owner
    const abort = new AbortController()
    controller = abort
    const timeout = setTimeout(() => abort.abort(), 15_000)
    active = (async () => {
      let more = false
      try {
        const locks = await navigator.locks.query()
        if (!valid()) return
        const excluded = new Set(blockedFiles)
        const prefix = `bookorbit-reading-copy:${owner}:`
        for (const lock of locks.held ?? []) {
          if (!lock.name?.startsWith(prefix)) continue
          const fileId = Number(lock.name.slice(prefix.length))
          if (Number.isSafeInteger(fileId) && fileId > 0) excluded.add(fileId)
        }
        const events = await readingEventOutbox.pendingForUser(owner, excluded)
        for (const event of events) {
          if (!valid() || abort.signal.aborted) break
          if (blockedFiles.has(event.fileId)) continue
          const available = await navigator.locks.request(readingEventLockName(owner, event.fileId), { ifAvailable: true }, (lock) => lock !== null)
          if (!available || !valid()) continue
          const response = await api(`/api/v1/libraries/${event.libraryId}/files/${event.fileId}/reading-events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...event.request, expectedUserId: owner }),
            signal: abort.signal,
          })
          if (!valid()) return
          if (!response.ok) {
            if ([400, 401, 403, 404, 409, 422].includes(response.status)) {
              blockedFiles.add(event.fileId)
              error.value = 'Some reading positions are saved on this device but could not synchronize.'
              continue
            }
            throw new Error('Reading synchronization will resume when the connection is available.')
          }
          const receipt = (await response.json()) as ReadingEventReceipt
          if (
            !['accepted', 'duplicate', 'superseded', 'reset_required'].includes(receipt.outcome) ||
            !Number.isSafeInteger(receipt.resetGeneration) ||
            receipt.resetGeneration < 0
          )
            throw new Error('Reading synchronization returned an invalid receipt')
          await navigator.locks.request(readingEventLockName(owner, event.fileId), { ifAvailable: true }, async (lock) => {
            if (lock && valid()) await readingEventOutbox.remove(owner, event.request.anchor.event!.id)
          })
        }
        if (!valid()) return
        failures = 0
        if (!blockedFiles.size) error.value = ''
        more = events.length === 20
      } catch (failure) {
        if (valid()) {
          failures++
          error.value = failure instanceof Error ? failure.message : 'Reading synchronization could not finish'
        }
      } finally {
        clearTimeout(timeout)
        if (controller === abort) controller = undefined
        active = null
        if (valid()) schedule(failures ? Math.min(60_000, 3000 * 2 ** failures) : more ? 3000 : 60_000)
      }
    })()
    return active
  }

  function wake() {
    if (!navigator.onLine || document.hidden) return
    failures = 0
    schedule(250)
  }
  function changed() {
    if (!active && !failures) schedule(250)
  }
  function retry() {
    blockedFiles.clear()
    failures = 0
    return flush()
  }
  watch(
    () => toValue(userId),
    () => {
      generation++
      controller?.abort()
      blockedFiles.clear()
      failures = 0
      error.value = ''
      schedule(250)
    },
    { immediate: true },
  )
  window.addEventListener('online', wake)
  window.addEventListener('bookorbit-reading-events-changed', changed)
  document.addEventListener('visibilitychange', wake)
  onScopeDispose(() => {
    disposed = true
    generation++
    controller?.abort()
    clearTimeout(timer)
    window.removeEventListener('online', wake)
    window.removeEventListener('bookorbit-reading-events-changed', changed)
    document.removeEventListener('visibilitychange', wake)
  })
  return { error, retry, flush }
}

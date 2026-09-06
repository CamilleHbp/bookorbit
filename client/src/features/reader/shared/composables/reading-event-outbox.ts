import type { ReadingAnchor, RecordReadingEventRequest } from '@bookorbit/types'

export interface PendingReadingEvent {
  id: string
  userId: number
  libraryId: number
  fileId: number
  queuedAt: number
  ordinal: number
  request: RecordReadingEventRequest
}

export class ReadingEventOutbox {
  private database: Promise<IDBDatabase> | undefined

  constructor(private readonly name = 'bookorbit-reading-events') {}

  private open() {
    this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 1)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('events', { keyPath: 'id' })
        store.createIndex('user', 'userId')
        store.createIndex('file', ['userId', 'fileId', 'ordinal'])
        request.result.createObjectStore('metadata')
      }
      request.onerror = () => reject(request.error ?? new Error('Reading storage is unavailable'))
      request.onblocked = () => reject(new Error('Close other BookOrbit tabs to open reading storage'))
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close()
          this.database = undefined
        }
        resolve(request.result)
      }
    }).catch((error: unknown) => {
      this.database = undefined
      throw error
    })
    return this.database
  }

  private async transaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore, result: (value: T) => void, fail: (error: Error) => void, metadata: IDBObjectStore) => void,
  ) {
    const database = await this.open()
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(['events', 'metadata'], mode, { durability: 'strict' })
      let result: T
      let failure: Error | undefined
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Reading storage could not be saved'))
      transaction.onerror = () => {
        failure ??= transaction.error ?? new Error('Reading storage could not be saved')
      }
      try {
        operation(
          transaction.objectStore('events'),
          (value) => {
            result = value
          },
          (error) => {
            failure = error
            transaction.abort()
          },
          transaction.objectStore('metadata'),
        )
      } catch (error) {
        failure = error instanceof Error ? error : new Error('Reading storage could not be saved')
        transaction.abort()
      }
    })
  }

  async put(userId: number, libraryId: number, fileId: number, anchor: ReadingAnchor) {
    if (![userId, libraryId, fileId].every((id) => Number.isSafeInteger(id) && id > 0) || !anchor.event?.id || anchor.bookFileId !== fileId)
      throw new Error('Reading event identity is incomplete')
    const request: RecordReadingEventRequest = { anchor, expectedUserId: userId }
    const serialized = JSON.stringify(request)
    if (new TextEncoder().encode(serialized).length > 32 * 1024) throw new Error('Reading event exceeds the offline storage limit')
    const row: PendingReadingEvent = {
      id: `${userId}:${anchor.event.id}`,
      userId,
      libraryId,
      fileId,
      queuedAt: Date.now(),
      ordinal: 0,
      request: JSON.parse(serialized) as RecordReadingEventRequest,
    }
    return this.transaction<PendingReadingEvent>('readwrite', (store, result, fail, metadata) => {
      const existing = store.get(row.id)
      existing.onsuccess = () => {
        const saved = existing.result as PendingReadingEvent | undefined
        if (saved) {
          if (saved.libraryId !== libraryId || saved.fileId !== fileId || JSON.stringify(saved.request) !== serialized)
            return fail(new Error('A reading event cannot be reused with different content'))
          result(saved)
          return
        }
        const total = store.count()
        total.onsuccess = () => {
          const owned = store.index('user').count(userId)
          owned.onsuccess = () => {
            if (total.result >= 2048 || owned.result >= 512)
              return fail(new Error('Offline reading storage is full. Reconnect to synchronize pending reading positions.'))
            const sequence = metadata.get('sequence')
            sequence.onsuccess = () => {
              const next = Number(sequence.result ?? 0) + 1
              if (!Number.isSafeInteger(next) || next < 1) return fail(new Error('Reading storage sequence is invalid'))
              row.ordinal = next
              metadata.put(next, 'sequence')
              store.add(row)
              result(row)
            }
          }
        }
      }
    })
  }

  async pending(userId: number, fileId: number, limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid reading event batch size')
    return this.transaction<PendingReadingEvent[]>('readonly', (store, result) => {
      const range = IDBKeyRange.bound([userId, fileId, 0], [userId, fileId, Number.MAX_SAFE_INTEGER])
      const request = store.index('file').openCursor(range, 'prev')
      const rows: PendingReadingEvent[] = []
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return result(rows)
        rows.push(cursor.value as PendingReadingEvent)
        if (rows.length === limit) result(rows)
        else cursor.continue()
      }
    })
  }

  async remove(userId: number, eventId: string) {
    await this.transaction<void>('readwrite', (store, result) => {
      store.delete(`${userId}:${eventId}`)
      result(undefined)
    })
  }

  async close() {
    const database = this.database
    this.database = undefined
    if (database) (await database).close()
  }
}

export const readingEventOutbox = new ReadingEventOutbox()

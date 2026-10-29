import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReadingAnchor } from '@bookorbit/types'
import { ReadingEventOutbox } from './reading-event-outbox'

describe('durable reading event storage', () => {
  let name: string
  let outbox: ReadingEventOutbox
  const anchor = (sequence = 1): ReadingAnchor => ({
    schemaVersion: 1,
    bookId: 2,
    bookFileId: 9,
    revision: '95f66679-bff3-4f7e-a8c6-1d4cf246700a',
    chapterIndex: 0,
    chapterFraction: 0.2,
    bookFraction: 0.1,
    quote: 'Original passage',
    event: { id: crypto.randomUUID(), deviceId: 'reader', deviceSequence: sequence, occurredAt: '2026-09-05T13:00:00.000Z', resetGeneration: 2 },
  })
  beforeEach(() => {
    name = `reading-events-test-${crypto.randomUUID()}`
    outbox = new ReadingEventOutbox(name)
  })
  afterEach(async () => {
    await outbox.close()
    indexedDB.deleteDatabase(name)
  })
  it('retains the original event across reopen and binds it to its account', async () => {
    const reading = anchor()
    const saved = await outbox.put(7, 5, 9, reading)
    reading.quote = 'Later mutable renderer state'
    await outbox.close()
    outbox = new ReadingEventOutbox(name)
    expect(await outbox.pending(7, 9)).toEqual([saved])
    expect(saved.request.expectedUserId).toBe(7)
    expect(saved.request.anchor.quote).toBe('Original passage')
    expect(saved.request.anchor.event).toEqual(reading.event)
    expect(await outbox.pending(8, 9)).toEqual([])
    expect(await outbox.pending(7, 10)).toEqual([])
    await outbox.remove(8, reading.event!.id)
    expect(await outbox.pending(7, 9)).toHaveLength(1)
    await outbox.remove(7, reading.event!.id)
    expect(await outbox.pending(7, 9)).toEqual([])
  })
  it('deduplicates concurrent saves while rejecting reuse with different reading content', async () => {
    const reading = anchor()
    const saved = await Promise.all([outbox.put(7, 5, 9, reading), outbox.put(7, 5, 9, reading)])
    expect(saved[0]).toEqual(saved[1])
    await expect(outbox.put(7, 5, 9, { ...reading, quote: 'Different passage' })).rejects.toThrow('different content')
    expect(await outbox.pending(7, 9)).toHaveLength(1)
  })
  it('bounds batches and storage without evicting unsent events', async () => {
    const events = Array.from({ length: 512 }, (_, index) => anchor(index + 1))
    await Promise.all(events.map((event) => outbox.put(7, 5, 9, event)))
    expect(await outbox.pending(7, 9)).toHaveLength(20)
    await expect(outbox.put(7, 5, 9, anchor(513))).rejects.toThrow('storage is full')
    await outbox.put(7, 5, 9, events[0]!)
    await outbox.put(8, 5, 9, anchor())
    expect(await outbox.pending(8, 9)).toHaveLength(1)
    await expect(outbox.pending(7, 9, 21)).rejects.toThrow('batch size')
    await outbox.remove(7, events[0]!.event!.id)
    await outbox.put(7, 5, 9, anchor(514))
  })
  it('rejects oversized or incomplete anchors before reserving storage', async () => {
    await expect(outbox.put(7, 5, 10, anchor())).rejects.toThrow('identity')
    await expect(outbox.put(7, 5, 9, { ...anchor(), quote: 'x'.repeat(33 * 1024) })).rejects.toThrow('storage limit')
    expect(await outbox.pending(7, 9)).toEqual([])
  })

  it('upgrades an existing queue without changing event identities or its local sequence', async () => {
    const reading = anchor()
    const saved = {
      id: `7:${reading.event!.id}`,
      userId: 7,
      libraryId: 5,
      fileId: 9,
      queuedAt: 1,
      ordinal: 41,
      request: { anchor: reading, expectedUserId: 7 },
    }
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => {
        const events = request.result.createObjectStore('events', { keyPath: 'id' })
        events.createIndex('user', 'userId')
        events.createIndex('file', ['userId', 'fileId', 'ordinal'])
        events.add(saved)
        request.result.createObjectStore('metadata').put(41, 'sequence')
      }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
    })
    expect(await outbox.pendingForUser(7, new Set())).toEqual([saved])
    const next = await outbox.put(7, 5, 9, anchor(2))
    expect(next.ordinal).toBe(42)
    expect(await outbox.pendingForUser(7, new Set())).toEqual([next, saved])
  })
})

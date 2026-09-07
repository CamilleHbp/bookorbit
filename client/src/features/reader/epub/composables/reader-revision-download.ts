import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { EpubReadingRevision } from '@bookorbit/types'

export const MAX_READER_EPUB_BYTES = 512 * 1024 * 1024
const PART_BYTES = 1024 * 1024

export async function readVerifiedRevision(response: Response, revision: EpubReadingRevision): Promise<Blob> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('EPUB revision download has no body')
  const hash = sha256.create()
  const parts: Blob[] = []
  let buffer = new Uint8Array(PART_BYTES)
  let filled = 0
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > revision.sizeBytes || received > MAX_READER_EPUB_BYTES) throw new Error('EPUB revision download exceeds its expected size')
      for (let offset = 0; offset < value.byteLength;) {
        const length = Math.min(PART_BYTES - filled, value.byteLength - offset)
        const chunk = value.subarray(offset, offset + length)
        hash.update(chunk)
        buffer.set(chunk, filled)
        filled += length
        offset += length
        if (filled === PART_BYTES) {
          parts.push(new Blob([buffer]))
          buffer = new Uint8Array(PART_BYTES)
          filled = 0
          if (parts.length % 8 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      }
    }
    if (received !== revision.sizeBytes) throw new Error('EPUB revision download was incomplete')
    if (bytesToHex(hash.digest()) !== revision.sha256) throw new Error('EPUB revision checksum verification failed')
    if (filled) parts.push(new Blob([buffer.subarray(0, filled)]))
    return new Blob(parts, { type: 'application/epub+zip' })
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    hash.destroy()
    reader.releaseLock()
  }
}

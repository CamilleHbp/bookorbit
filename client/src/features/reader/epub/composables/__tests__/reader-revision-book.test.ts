import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EpubReadingRevision } from '@bookorbit/types'
import { api } from '@/lib/api'
import { loadRevisionBook } from '../reader-revision-book'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const request = vi.mocked(api)
const bytes = new TextEncoder().encode('verified EPUB bytes')
const revision: EpubReadingRevision = {
  bookId: 2,
  bookFileId: 9,
  libraryId: 5,
  revision: 'revision-one',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  sizeBytes: bytes.length,
}
const headers = { 'X-BookOrbit-Revision': revision.revision, 'X-BookOrbit-SHA256': revision.sha256 }
function prepare(body: BodyInit | null = bytes, identity = revision) {
  request.mockResolvedValueOnce(Response.json(identity))
  request.mockResolvedValueOnce(new Response(body, { headers }))
}
beforeEach(() => vi.resetAllMocks())

describe('verified reader revision download', () => {
  it('verifies fragmented bytes before requesting canonical reading state', async () => {
    const chunks = [bytes.slice(0, 2), bytes.slice(2, 7), bytes.slice(7)]
    prepare(
      new ReadableStream({
        pull(controller) {
          const next = chunks.shift()
          if (next) controller.enqueue(next)
          else controller.close()
        },
      }),
    )
    request.mockResolvedValueOnce(Response.json({ resetGeneration: 4, anchor: null }))
    const result = await loadRevisionBook(2, 9, true)
    expect(result.file.size).toBe(bytes.length)
    expect(result.state.resetGeneration).toBe(4)
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/epub/2/files/9/revision',
      '/api/v1/epub/2/files/9/revisions/revision-one',
      '/api/v1/libraries/5/files/9/reading-events',
    ])
  })
  it('rejects equal-length altered bytes despite matching revision headers', async () => {
    const changed = bytes.slice()
    changed[0] = changed[0]! ^ 1
    prepare(changed)
    await expect(loadRevisionBook(2, 9, true)).rejects.toThrow('checksum verification failed')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('cancels oversized streams without waiting for their end', async () => {
    const cancel = vi.fn<() => void>()
    prepare(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(bytes)
        },
        cancel,
      }),
    )
    await expect(loadRevisionBook(2, 9, true)).rejects.toThrow('exceeds its expected size')
    expect(cancel).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('rejects truncated downloads', async () => {
    prepare(bytes.slice(0, 3))
    await expect(loadRevisionBook(2, 9, false)).rejects.toThrow('incomplete')
  })
  it('rejects a missing body', async () => {
    prepare(null)
    await expect(loadRevisionBook(2, 9, false)).rejects.toThrow('no body')
  })
  it.each([-1, 0, 0.5, 512 * 1024 * 1024 + 1, null])('rejects invalid advertised sizes before downloading: %s', async (sizeBytes) => {
    request.mockResolvedValueOnce(Response.json({ ...revision, sizeBytes }))
    await expect(loadRevisionBook(2, 9, false)).rejects.toThrow('Invalid EPUB revision identity')
    expect(request).toHaveBeenCalledOnce()
  })
  it('cancels a response with stale revision headers', async () => {
    request.mockResolvedValueOnce(Response.json(revision))
    const cancel = vi.fn<() => void>()
    request.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { ...headers, 'X-BookOrbit-Revision': 'stale' } }))
    await expect(loadRevisionBook(2, 9, true)).rejects.toThrow('changed while opening')
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('verifies a multi-part file without reading activity when tracking is disabled', async () => {
    const large = new Uint8Array(2 * 1024 * 1024 + 17).fill(97)
    const identity = { ...revision, sizeBytes: large.length, sha256: createHash('sha256').update(large).digest('hex') }
    request.mockResolvedValueOnce(Response.json(identity))
    request.mockResolvedValueOnce(new Response(large, { headers: { ...headers, 'X-BookOrbit-SHA256': identity.sha256 } }))
    const result = await loadRevisionBook(2, 9, false)
    expect(result.file.size).toBe(large.length)
    const assembled = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(result.file)
    })
    expect(createHash('sha256').update(new Uint8Array(assembled)).digest('hex')).toBe(identity.sha256)
    expect(request).toHaveBeenCalledTimes(2)
  })
})

import type { CanonicalReadingState, EpubReadingRevision } from '@bookorbit/types'
import { api } from '@/lib/api'

export async function loadRevisionBook(bookId: number, fileId: number, trackReading: boolean) {
  const info = await api(`/api/v1/epub/${bookId}/files/${fileId}/revision`)
  if (!info.ok) throw new Error(`Failed to inspect EPUB revision: ${info.status}`)
  const revision = (await info.json()) as EpubReadingRevision
  if (revision.bookId !== bookId || revision.bookFileId !== fileId || !revision.revision || revision.sizeBytes > 512 * 1024 * 1024) {
    throw new Error('Invalid EPUB revision identity')
  }
  const response = await api(`/api/v1/epub/${bookId}/files/${fileId}/revisions/${revision.revision}`)
  if (
    !response.ok ||
    response.headers.get('X-BookOrbit-Revision') !== revision.revision ||
    response.headers.get('X-BookOrbit-SHA256') !== revision.sha256
  ) {
    throw new Error('EPUB revision changed while opening the book')
  }
  const blob = await response.blob()
  if (blob.size !== revision.sizeBytes) throw new Error('EPUB revision download was incomplete')
  let state: CanonicalReadingState = { resetGeneration: 0, anchor: null }
  if (trackReading) {
    const result = await api(`/api/v1/libraries/${revision.libraryId}/files/${fileId}/reading-events`)
    if (!result.ok) throw new Error(`Failed to read the saved position: ${result.status}`)
    state = (await result.json()) as CanonicalReadingState
  }
  return { revision, state, file: new File([blob], `book-file-${fileId}.epub`, { type: 'application/epub+zip' }) }
}

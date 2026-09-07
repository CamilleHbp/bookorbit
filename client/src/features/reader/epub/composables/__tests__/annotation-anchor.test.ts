import { describe, expect, it, vi } from 'vitest'
import type { EpubReadingRevision } from '@bookorbit/types'
import { captureAnnotationAnchor, type AnchorView } from '../reader-native-anchor'

const revision: EpubReadingRevision = {
  bookId: 1,
  bookFileId: 2,
  libraryId: 3,
  revision: 'original-revision',
  sha256: 'a'.repeat(64),
  sizeBytes: 100,
}
function fixture() {
  const doc = new DOMParser().parseFromString('<p>Before Café 😀 selected words after.</p>', 'text/html')
  const range = doc.createRange()
  range.setStart(doc.querySelector('p')!.firstChild!, 7)
  range.setEnd(doc.querySelector('p')!.firstChild!, 29)
  const view: AnchorView = {
    book: { sections: [{ id: 'chapter.xhtml' }] },
    renderer: { getContents: () => [{ index: 0, doc }] },
    resolveCFI: () => ({ index: 0, anchor: () => range }),
    getCFI: vi.fn<AnchorView['getCFI']>(),
    goTo: vi.fn<AnchorView['goTo']>(),
    getSectionFractions: () => [0, 1],
  }
  return { view, range }
}
describe('annotation source capture', () => {
  it('captures the selection without navigation or a reading event', () => {
    const { view, range } = fixture()
    const anchor = captureAnnotationAnchor(view, revision, 'selection-cfi', range.toString())!
    expect(anchor).toMatchObject({ bookId: 1, bookFileId: 2, revision: 'original-revision', nativeLocator: { kind: 'cfi', value: 'selection-cfi' } })
    expect(anchor.quote).toContain('Café 😀 selected words')
    expect(anchor.prefix).toBe('Before')
    expect(anchor.event).toBeUndefined()
    expect(view.goTo).not.toHaveBeenCalled()
  })
  it('declines stale selections and unavailable documents', () => {
    const { view } = fixture()
    expect(captureAnnotationAnchor(view, revision, 'selection-cfi', 'unrelated words')).toBeNull()
    view.renderer.getContents = () => []
    expect(captureAnnotationAnchor(view, revision, 'selection-cfi', 'selected words')).toBeNull()
  })
  it('declines invalid native locators', () => {
    const { view } = fixture()
    view.resolveCFI = () => {
      throw new Error('Invalid CFI')
    }
    expect(captureAnnotationAnchor(view, revision, 'invalid', 'selected words')).toBeNull()
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { AnnotationItem, EpubReadingRevision } from '@bookorbit/types'
import { createAnnotationProjector } from '../reader-annotation-projection'
import { captureDomPassage, indexAnchorDocument } from '../reader-anchor-dom'
import type { AnchorView } from '../reader-native-anchor'

const passage = 'Café 😀 marked words beside the old stone bridge.'
const documentFor = (body: string) => new DOMParser().parseFromString(`<p>${body}</p>`, 'text/html')
const revision: EpubReadingRevision = { bookId: 1, bookFileId: 2, libraryId: 3, revision: 'new', sha256: 'a'.repeat(64), sizeBytes: 100 }
function fixture(bodies = [`New introduction. ${passage}`]) {
  const original = documentFor(passage)
  const range = original.createRange()
  range.selectNodeContents(original.querySelector('p')!)
  range.setStart(original.querySelector('p')!.firstChild!, 0)
  const annotation: AnnotationItem = {
    id: 1,
    bookId: 1,
    jumpFileId: 2,
    cfi: 'old',
    pageno: null,
    text: passage,
    color: 'yellow',
    style: 'highlight',
    note: null,
    chapterTitle: 'Chapter',
    origin: 'web',
    positionStatus: 'exact',
    chapterIndex: 0,
    createdAt: '2026-01-01T00:00:00Z',
    sourceAnchor: {
      schemaVersion: 1,
      bookId: 1,
      bookFileId: 2,
      revision: 'old',
      nativeLocator: { kind: 'cfi', value: 'old' },
      chapterIndex: 0,
      chapterHref: 'old.xhtml',
      bookFraction: 0,
      ...captureDomPassage(indexAnchorDocument(original, 500), range)!,
    },
  }
  const docs = bodies.map(documentFor)
  const locators = new Map<string, { index: number; range: Range }>()
  const view: AnchorView = {
    book: { sections: docs.map((doc, i) => ({ id: `regenerated-${i}.xhtml`, createDocument: async () => doc })) },
    renderer: { getContents: () => [] },
    goTo: vi.fn<AnchorView['goTo']>(),
    getCFI: (index, range) => {
      const cfi = `mapped-${index}`
      locators.set(cfi, { index, range })
      return cfi
    },
    resolveCFI: (cfi) => {
      const entry = locators.get(cfi)!
      return { index: entry.index, anchor: () => entry.range.cloneRange() }
    },
  }
  return { view, annotation, docs, locators }
}
describe('revision-aware annotation projections', () => {
  it('finds the passage after an empty chapter is inserted', async () => {
    const { view, annotation } = fixture(['', passage])
    expect(await createAnnotationProjector(view, revision)(annotation)).toEqual({ cfi: 'mapped-1', positionStatus: 'repaired' })
  })

  it('does not block opening when a chapter document never arrives', async () => {
    const { view, annotation } = fixture()
    view.book!.sections[0]!.createDocument = () => new Promise<Document>(() => {})
    expect(await createAnnotationProjector(view, revision)(annotation, 5)).toEqual({ cfi: null, positionStatus: 'pending' })
  })

  it('relocates a full Unicode selection after chapter regeneration without navigation', async () => {
    const { view, annotation, locators } = fixture()
    const originalAnchor = structuredClone(annotation.sourceAnchor)
    const result = await createAnnotationProjector(view, revision)(annotation)
    expect(result).toEqual({ cfi: 'mapped-0', positionStatus: 'repaired' })
    expect(locators.get(result.cfi!)?.range.toString()).toBe(passage)
    expect(annotation.sourceAnchor).toEqual(originalAnchor)
    expect(view.goTo).not.toHaveBeenCalled()
  })
  it.each([[`${passage} ${passage}`], [passage, passage], ['A different passage at the reused native position.']])(
    'leaves ambiguous or removed passages pending: %j',
    async (...bodies) => {
      const { view, annotation } = fixture(bodies)
      expect(await createAnnotationProjector(view, revision)(annotation)).toEqual({ cfi: null, positionStatus: 'pending' })
    },
  )
  it('verifies the generated native range instead of trusting its text alone', async () => {
    const { view, annotation, docs } = fixture()
    view.resolveCFI = () => ({
      index: 0,
      anchor: () => {
        const range = docs[0]!.createRange()
        range.selectNodeContents(docs[0]!.body)
        return range
      },
    })
    expect((await createAnnotationProjector(view, revision)(annotation)).cfi).toBeNull()
  })
  it('rejects another file and finishes immediately when its budget is exhausted', async () => {
    const { view, annotation } = fixture()
    const project = createAnnotationProjector(view, revision)
    expect((await project(annotation, 0)).cfi).toBeNull()
    annotation.sourceAnchor!.bookFileId = 3
    expect((await project(annotation)).cfi).toBeNull()
  })
})

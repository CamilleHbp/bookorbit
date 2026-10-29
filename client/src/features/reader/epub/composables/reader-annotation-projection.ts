import { normalizeAnchorText, scalarLength, type AnnotationItem, type EpubReadingRevision } from '@bookorbit/types'
import type { AnchorView } from './reader-native-anchor'
import { indexAnchorDocument, locateDomPassage, nativeRangeAt, scalarOffsetAt, type AnchorDomIndex } from './reader-anchor-dom'
import { verifiesAnnotationRange } from './annotation-range'

export type AnnotationProjection = Pick<AnnotationItem, 'cfi' | 'positionStatus'>
const pending: AnnotationProjection = { cfi: null, positionStatus: 'pending' }

function selectedRange(index: AnchorDomIndex, start: Range, text: string): Range | null {
  const offset = scalarOffsetAt(index, start)
  const length = scalarLength(normalizeAnchorText(text))
  if (offset === null || !length || offset + length > index.offsets.length) return null
  const last = nativeRangeAt(index, offset + length - 1)
  if (!last || last.startContainer.nodeType !== 3) return null
  const point = last.startContainer.nodeValue?.codePointAt(last.startOffset)
  if (point === undefined) return null
  const range = start.cloneRange()
  range.setEnd(last.startContainer, last.startOffset + (point > 0xffff ? 2 : 1))
  return verifiesAnnotationRange(range, text) ? range : null
}

export function createAnnotationProjector(view: AnchorView, revision: EpubReadingRevision) {
  const documents = new Map<number, AnchorDomIndex>()
  async function getDocument(section: number, deadline: number): Promise<AnchorDomIndex | null> {
    const cached = documents.get(section)
    if (cached) return cached
    const loaded = view.renderer.getContents?.().find((item) => item.index === section)?.doc
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const create = view.book?.sections[section]?.createDocument
      const doc =
        loaded ??
        (create &&
          (await Promise.race([
            create().catch(() => null),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), Math.max(0, deadline - performance.now()))
            }),
          ])))
      if (!doc || performance.now() >= deadline) return null
      const indexed = indexAnchorDocument(doc, Math.min(40, deadline - performance.now()))
      if (indexed.truncated) return null
      if (documents.size >= 4) documents.delete(documents.keys().next().value!)
      documents.set(section, indexed)
      return indexed
    } finally {
      clearTimeout(timer)
    }
  }

  return async (annotation: AnnotationItem, budgetMs = 100): Promise<AnnotationProjection> => {
    const anchor = annotation.sourceAnchor
    if (!anchor) return { cfi: annotation.cfi, positionStatus: annotation.positionStatus }
    if (anchor.bookId !== revision.bookId || anchor.bookFileId !== revision.bookFileId || !view.resolveCFI || annotation.text.length > 16_384)
      return pending
    const deadline = performance.now() + Math.max(0, Math.min(100, budgetMs))
    try {
      if (anchor.revision === revision.revision && anchor.nativeLocator?.kind === 'cfi') {
        const resolved = view.resolveCFI(anchor.nativeLocator.value)
        const indexed = await getDocument(resolved.index, deadline)
        if (indexed && verifiesAnnotationRange(resolved.anchor(indexed.document), annotation.text)) {
          return { cfi: anchor.nativeLocator.value, positionStatus: 'exact' }
        }
        return pending
      }
      const sections = view.book?.sections ?? []
      const choices = new Set<number>()
      for (let i = 0; i < Math.min(sections.length, 10_000); i++) {
        if (anchor.chapterHref && sections[i]?.id === anchor.chapterHref) choices.add(i)
      }
      // Ordinals only limit the search. Passage context and the resulting native range still have to match.
      for (const i of [anchor.chapterIndex - 1, anchor.chapterIndex, anchor.chapterIndex + 1]) {
        if (i >= 0 && i < sections.length) choices.add(i)
      }
      if (!choices.size || choices.size > 4) return pending
      let target: string | null = null
      for (const section of choices) {
        if (performance.now() >= deadline) return pending
        const indexed = await getDocument(section, deadline)
        if (!indexed) return pending
        const start = locateDomPassage(indexed, anchor)
        const range = start && selectedRange(indexed, start, annotation.text)
        if (!range) continue
        const cfi = view.getCFI(section, range)
        if (!cfi || target) return pending
        const native = view.resolveCFI(cfi)
        if (native.index !== section) return pending
        const verified = native.anchor(indexed.document)
        if (
          !verifiesAnnotationRange(verified, annotation.text) ||
          verified.compareBoundaryPoints(0, range) !== 0 ||
          verified.compareBoundaryPoints(2, range) !== 0
        )
          return pending
        target = cfi
      }
      return target && performance.now() < deadline ? { cfi: target, positionStatus: 'repaired' } : pending
    } catch {
      return pending
    }
  }
}

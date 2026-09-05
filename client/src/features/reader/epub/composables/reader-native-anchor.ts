import type { EpubReadingRevision, ReadingAnchor, RevisionPositionAcknowledgement } from '@bookorbit/types'
import { captureDomPassage, indexAnchorDocument, locateDomPassage, type AnchorDomIndex } from './reader-anchor-dom'

export interface AnchorView {
  book?: { sections: { id?: string; createDocument?: () => Promise<Document> }[]; toc?: TocItem[]; resolveHref?: (href: string) => { index: number } }
  lastLocation?: {
    cfi?: string
    range?: Range
    fraction?: number
    source?: string
    tocItem?: { label?: string }
    contentSourceProgressPercent?: number
  }
  renderer: { getContents?: () => { index: number; doc?: Document }[] }
  getCFI: (index: number, range: Range) => string | null
  resolveCFI?: (cfi: string) => { index: number; anchor: (doc: Document) => Range }
  goTo: (target: string | number) => Promise<unknown>
  goToFraction?: (fraction: number) => Promise<void> | void
  getSectionFractions?: () => number[]
}
interface TocItem {
  label?: string
  href?: string
  subitems?: TocItem[]
  children?: TocItem[]
}
const clamp = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)
const indexes = new WeakMap<Document, AnchorDomIndex>()
function index(document: Document) {
  let result = indexes.get(document)
  if (!result) {
    result = indexAnchorDocument(document)
    indexes.set(document, result)
  }
  return result
}

export function captureNativeAnchor(view: AnchorView, revision: EpubReadingRevision): ReadingAnchor | null {
  const location = view.lastLocation
  const range = location?.range
  if (!range || !location.cfi || !view.book?.sections) return null
  const document = range.startContainer.ownerDocument
  if (!document) return null
  const section = view.renderer.getContents?.().find((item) => item.doc === document)
  if (!section) return null
  const passage = captureDomPassage(index(document), range)
  return {
    schemaVersion: 1,
    bookId: revision.bookId,
    bookFileId: revision.bookFileId,
    revision: revision.revision,
    nativeLocator: { kind: 'cfi', value: location.cfi },
    chapterIndex: section.index,
    chapterHref: view.book.sections[section.index]?.id,
    chapterTitle: location.tocItem?.label,
    chapterFraction: clamp((location.contentSourceProgressPercent ?? 0) / 100),
    bookFraction: clamp(location.fraction ?? 0),
    ...passage,
  }
}

function candidateSections(view: AnchorView, anchor: ReadingAnchor): number[] {
  const sections = view.book?.sections ?? []
  const found = new Set<number>()
  for (let i = 0; i < Math.min(10_000, sections.length); i++) if (sections[i]?.id === anchor.chapterHref) found.add(i)
  const stack = [...(view.book?.toc ?? [])]
  for (let count = 0; stack.length && count < 10_000; count++) {
    const item = stack.pop()!
    if (item.label === anchor.chapterTitle && item.href && view.book?.resolveHref) {
      try {
        found.add(view.book.resolveHref(item.href).index)
      } catch {
        /* Invalid navigation entries cannot establish chapter identity. */
      }
    }
    const children = item.subitems ?? item.children ?? []
    if (stack.length + children.length <= 10_000) stack.push(...children)
  }
  return [...found].filter((value) => value >= 0 && value < sections.length)
}

function verify(view: AnchorView, target: string): boolean {
  const actual = view.lastLocation?.range
  if (!actual || !view.resolveCFI) return false
  try {
    const resolved = view.resolveCFI(target)
    const document = actual.startContainer.ownerDocument!
    const expected = resolved.anchor(document)
    return document.contains(expected.startContainer) && actual.comparePoint(expected.startContainer, expected.startOffset) === 0
  } catch {
    return false
  }
}

async function boundedDocument(create: () => Promise<Document>, remainingMs: number): Promise<Document | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      create().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, remainingMs))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function restoreNativeAnchor(
  view: AnchorView,
  anchor: ReadingAnchor,
  revision: EpubReadingRevision,
): Promise<RevisionPositionAcknowledgement | null> {
  let target: string | null = null
  let quality: RevisionPositionAcknowledgement['quality'] = 'approximate'
  if (anchor.revision === revision.revision && anchor.nativeLocator?.kind === 'cfi') {
    target = anchor.nativeLocator.value
    quality = 'exact'
  } else {
    const choices = candidateSections(view, anchor)
    const deadline = performance.now() + 200
    if (choices.length <= 4) {
      for (const sectionIndex of choices) {
        if (performance.now() >= deadline) break
        const section = view.book?.sections[sectionIndex]
        if (!section?.createDocument) continue
        const document = await boundedDocument(() => section.createDocument!(), deadline - performance.now())
        if (!document || performance.now() >= deadline) break
        const range = locateDomPassage(index(document), anchor)
        const candidate = range && view.getCFI(sectionIndex, range)
        if (candidate) {
          if (target) {
            target = null
            break
          }
          target = candidate
          quality = 'relocated'
        }
      }
    }
    if (!target) {
      const fractions = view.getSectionFractions?.() ?? []
      const choice = choices.length === 1 ? choices[0] : undefined
      let fraction = anchor.bookFraction
      if (choice !== undefined && fractions[choice] !== undefined) {
        const first = fractions[choice]!
        fraction = first + clamp(anchor.chapterFraction) * ((fractions[choice + 1] ?? 1) - first)
      }
      if (view.goToFraction) await view.goToFraction(clamp(fraction))
      else await view.goTo(choice ?? 0)
    }
  }
  if (target) {
    try {
      await view.goTo(target)
    } catch {
      quality = 'approximate'
    }
    if (!verify(view, target)) {
      quality = 'approximate'
      if (view.goToFraction) await view.goToFraction(clamp(anchor.bookFraction))
      else await view.goTo(0)
    }
  }
  const actual = view.lastLocation?.cfi
  if (!actual || !verify(view, actual) || !anchor.event) return null
  return { eventId: anchor.event.id, revision: revision.revision, nativeLocator: { kind: 'cfi', value: actual }, quality }
}

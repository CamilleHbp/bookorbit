import { normalizeAnchorTextWithOffsets, normalizeAnchorText, scalarLength, type ReadingAnchor } from '@bookorbit/types'

interface Segment {
  node: Text
  offset: number
  length: number
}
export interface AnchorDomIndex {
  text: string
  offsets: number[]
  segments: Segment[]
  truncated: boolean
  document: Document
}
const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
const OMIT = new Set(['HEAD', 'SCRIPT', 'STYLE'])

export function indexAnchorDocument(document: Document, budgetMs = 40): AnchorDomIndex {
  const deadline = performance.now() + budgetMs
  const stack: { node: Node; ending?: boolean }[] = document.body ? [{ node: document.body }] : []
  const pieces: string[] = []
  const segments: Segment[] = []
  let length = 0
  let nodes = 0
  let truncated = false
  while (stack.length && length < 100_000 && nodes++ < 30_000 && performance.now() < deadline) {
    const { node, ending } = stack.pop()!
    if (ending) {
      pieces.push(' ')
      length++
      continue
    }
    if (node.nodeType === 3) {
      let text = (node.nodeValue ?? '').slice(0, 100_000 - length)
      if (text.length < (node.nodeValue?.length ?? 0)) {
        truncated = true
        const last = text.charCodeAt(text.length - 1)
        if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
      }
      segments.push({ node: node as Text, offset: length, length: text.length })
      pieces.push(text)
      length += text.length
    } else if (node.nodeType === 1) {
      const element = node as Element
      if (OMIT.has(element.tagName.toUpperCase()) || element.hasAttribute('hidden')) continue
      if (element.tagName.toUpperCase() === 'BR') {
        pieces.push(' ')
        length++
        continue
      }
      if (BLOCKS.has(element.tagName.toUpperCase())) stack.push({ node, ending: true })
      for (let child = node.lastChild; child; child = child.previousSibling) {
        if (stack.length >= 30_000) {
          truncated = true
          break
        }
        stack.push({ node: child })
      }
    }
  }
  const normalized = normalizeAnchorTextWithOffsets(pieces.join(''))
  return { text: normalized.text, offsets: normalized.nativeOffsets, segments, truncated: truncated || stack.length > 0, document }
}

export function nativeRangeAt(index: AnchorDomIndex, scalar: number): Range | null {
  const offset = index.offsets[Math.max(0, Math.min(index.offsets.length - 1, scalar))]
  if (offset === undefined || !index.segments.length) return null
  let low = 0,
    high = index.segments.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (index.segments[middle]!.offset <= offset) low = middle
    else high = middle - 1
  }
  const segment = index.segments[low]!
  const range = index.document.createRange()
  range.setStart(segment.node, Math.max(0, Math.min(segment.length, offset - segment.offset)))
  range.collapse(true)
  return range
}

export function scalarOffsetAt(index: AnchorDomIndex, range: Range): number | null {
  const segment = index.segments.find((entry) => entry.node === range.startContainer)
  if (!segment) return null
  const native = segment.offset + range.startOffset
  let low = 0,
    high = index.offsets.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (index.offsets[middle]! <= native) low = middle
    else high = middle - 1
  }
  return low
}

export function captureDomPassage(index: AnchorDomIndex, range: Range) {
  const offset = scalarOffsetAt(index, range)
  if (offset === null || index.truncated) return null
  const scalars = Array.from(index.text)
  return {
    quote: scalars.slice(offset, offset + 256).join(''),
    prefix: normalizeAnchorText(scalars.slice(Math.max(0, offset - 128), offset).join('')),
    suffix: normalizeAnchorText(scalars.slice(offset + 256, offset + 384).join('')),
    chapterFraction: offset / Math.max(1, scalars.length),
  }
}

export function locateDomPassage(index: AnchorDomIndex, anchor: ReadingAnchor): Range | null {
  if (!anchor.quote || scalarLength(anchor.quote) < 16 || index.truncated) return null
  const deadline = performance.now() + 30
  let position = -1,
    found = -1,
    matches = 0
  while (matches++ < 200 && performance.now() < deadline) {
    position = index.text.indexOf(anchor.quote, position + 1)
    if (position < 0) break
    const before = normalizeAnchorText(index.text.slice(Math.max(0, position - 512), position))
    const after = normalizeAnchorText(index.text.slice(position + anchor.quote.length, position + anchor.quote.length + 512))
    if ((!anchor.prefix || before.endsWith(anchor.prefix)) && (!anchor.suffix || after.startsWith(anchor.suffix))) {
      if (found >= 0) return null
      found = position
    }
  }
  if (found < 0 || matches >= 200 || performance.now() >= deadline) return null
  return nativeRangeAt(index, scalarLength(index.text.slice(0, found)))
}

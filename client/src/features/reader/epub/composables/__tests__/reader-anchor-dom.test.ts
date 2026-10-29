import { describe, expect, it } from 'vitest'
import type { ReadingAnchor } from '@bookorbit/types'
import { captureDomPassage, indexAnchorDocument, locateDomPassage, nativeRangeAt } from '../reader-anchor-dom'

const documentFor = (body: string) => new DOMParser().parseFromString(`<html><body>${body}</body></html>`, 'text/html')
describe('portable DOM reading anchors', () => {
  it('uses shared Unicode normalization while mapping back to native UTF-16 offsets', () => {
    const document = documentFor('<p>Café\u00a0 café 中文 😀 text</p><div hidden>excluded</div><script>excluded()</script><p>Next paragraph</p>')
    const indexed = indexAnchorDocument(document, 500)
    expect(indexed.text).toBe('Café café 中文 😀 text Next paragraph')
    const scalar = Array.from(indexed.text).indexOf('😀')
    const range = nativeRangeAt(indexed, scalar)!
    expect(range.startContainer.nodeValue?.slice(range.startOffset)).toBe('😀 text')
  })
  it('relocates a captured quote after filenames, paragraph IDs, and preceding text change', () => {
    const passage = 'An unmistakable passage followed the narrow stone path beside the water. '.repeat(6)
    const original = documentFor(`<p id="old">${passage}</p>`)
    const range = original.createRange()
    range.setStart(original.querySelector('p')!.firstChild!, 0)
    const captured = captureDomPassage(indexAnchorDocument(original, 500), range)!
    const target = documentFor(`<p>New introductory material.</p><p id="regenerated">${passage}</p>`)
    const anchor = { revision: 'old', chapterIndex: 0, bookFraction: 0.8, ...captured } satisfies ReadingAnchor
    const result = locateDomPassage(indexAnchorDocument(target, 500), anchor)!
    expect(result.startContainer.parentElement?.id).toBe('regenerated')
    expect(result.startOffset).toBe(0)
  })
  it('does not select an unrelated repeated passage without distinguishing context', () => {
    const quote = 'The same words appeared in two different places.'
    const target = documentFor(`<p>${quote}</p><p>${quote}</p>`)
    const anchor = { revision: 'old', chapterIndex: 0, chapterFraction: 0.5, bookFraction: 0.8, quote }
    expect(locateDomPassage(indexAnchorDocument(target, 500), anchor)).toBeNull()
  })
  it('reports a bounded index as incomplete and declines precise resolution', () => {
    const document = documentFor(`<p>${'😀'.repeat(60_000)}</p>`)
    const indexed = indexAnchorDocument(document, 500)
    expect(indexed.truncated).toBe(true)
    expect(indexed.text.length).toBeLessThanOrEqual(100_000)
    const range = document.createRange()
    range.setStart(document.querySelector('p')!.firstChild!, 0)
    expect(captureDomPassage(indexed, range)).toBeNull()
  })
})

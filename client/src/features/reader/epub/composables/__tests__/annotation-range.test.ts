import { describe, expect, it } from 'vitest'
import { verifiesAnnotationRange } from '../annotation-range'

describe('annotation range verification', () => {
  function rangeFor(html: string) {
    const document = new DOMParser().parseFromString(html, 'text/html')
    const range = document.createRange()
    range.selectNodeContents(document.body)
    return range
  }

  it('checks inline text with the shared Unicode and whitespace specification', () => {
    expect(verifiesAnnotationRange(rangeFor('<p>Cafe\u0301 <em>under</em> the\u00a0moon</p>'), 'Cafe\u0301 under the moon')).toBe(true)
    expect(verifiesAnnotationRange(rangeFor('<p>A different passage</p>'), 'Café under the moon')).toBe(false)
  })

  it('checks only selected offsets, including a range within one text node', () => {
    const range = rangeFor('<p>Before selected passage after</p>')
    const node = range.startContainer.firstChild!.firstChild!
    range.setStart(node, 7)
    range.setEnd(node, 23)
    expect(verifiesAnnotationRange(range, 'selected passage')).toBe(true)
    expect(verifiesAnnotationRange(range, 'Before selected passage after')).toBe(false)
  })

  it('leaves empty, missing and over-budget selections unverified', () => {
    expect(verifiesAnnotationRange(undefined, 'passage')).toBe(false)
    expect(verifiesAnnotationRange(rangeFor('<p>passage</p>'), '\ud800')).toBe(false)
    expect(verifiesAnnotationRange(rangeFor('<p> </p>'), ' ')).toBe(false)
    expect(verifiesAnnotationRange(rangeFor('<p>passage</p>'), 'passage', 0)).toBe(false)
    expect(verifiesAnnotationRange(rangeFor(`<p>${'a'.repeat(20_000)}</p>`), 'a')).toBe(false)
    expect(verifiesAnnotationRange(rangeFor('<p>a</p>'), 'a'.repeat(20_000))).toBe(false)
    const many = '<span>x</span>'.repeat(2_001)
    expect(verifiesAnnotationRange(rangeFor(many), 'x'.repeat(2_001))).toBe(false)
  })
})

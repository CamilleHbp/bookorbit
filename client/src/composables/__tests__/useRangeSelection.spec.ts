import { describe, expect, it } from 'vitest'
import { isRowSelectionClick, isSelectAllShortcut, useRangeSelection } from '../useRangeSelection'

const ids = ['a', 'b', 'c', 'd', 'e']

describe('useRangeSelection', () => {
  it('returns only the clicked row without Shift', () => {
    const range = useRangeSelection<string>()
    expect(range.targets('b', ids, false)).toEqual(['b'])
    expect(range.targets('d', ids, false)).toEqual(['d'])
  })

  it('extends from the last clicked row in either direction', () => {
    const range = useRangeSelection<string>()
    range.targets('b', ids, false)
    expect(range.targets('d', ids, true)).toEqual(['b', 'c', 'd'])
    expect(range.targets('a', ids, true)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('falls back to the clicked row when the anchor left the list', () => {
    const range = useRangeSelection<string>()
    range.targets('z', ['z'], false)
    expect(range.targets('c', ids, true)).toEqual(['c'])
    range.reset()
    expect(range.targets('e', ids, true)).toEqual(['e'])
  })
})

describe('selection shortcuts', () => {
  it('treats modifier clicks outside controls as row selection', () => {
    const row = document.createElement('div')
    const link = document.createElement('a')
    row.append(link)
    const click = (target: Element, init: MouseEventInit) => {
      const event = new MouseEvent('click', init)
      Object.defineProperty(event, 'target', { value: target })
      return event
    }
    expect(isRowSelectionClick(click(row, { metaKey: true }))).toBe(true)
    expect(isRowSelectionClick(click(row, { shiftKey: true }))).toBe(true)
    expect(isRowSelectionClick(click(row, {}))).toBe(false)
    expect(isRowSelectionClick(click(link, { ctrlKey: true }))).toBe(false)
  })

  it('ignores select-all inside text fields', () => {
    const key = (target: Element, init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', init)
      Object.defineProperty(event, 'target', { value: target })
      return event
    }
    const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox' })
    const text = document.createElement('input')
    expect(isSelectAllShortcut(key(checkbox, { key: 'a', ctrlKey: true }))).toBe(true)
    expect(isSelectAllShortcut(key(checkbox, { key: 'A', metaKey: true }))).toBe(true)
    expect(isSelectAllShortcut(key(text, { key: 'a', metaKey: true }))).toBe(false)
    expect(isSelectAllShortcut(key(checkbox, { key: 'a' }))).toBe(false)
  })
})

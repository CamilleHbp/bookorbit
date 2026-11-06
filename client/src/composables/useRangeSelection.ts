const INTERACTIVE = 'a, button, input, select, textarea, label, summary, [role="button"], [role="menuitem"], [contenteditable="true"]'

function insideInteractive(event: Event) {
  return event.target instanceof Element && event.target.closest(INTERACTIVE) !== null
}

/** A Shift, Ctrl or Cmd click on a non-interactive part of a selectable row. */
export function isRowSelectionClick(event: MouseEvent) {
  return (event.shiftKey || event.ctrlKey || event.metaKey) && !event.altKey && !insideInteractive(event)
}

export function isSelectAllShortcut(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== 'a' || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return false
  const target = event.target
  return !(
    target instanceof HTMLElement &&
    (target.isContentEditable || target.matches('textarea, select, input:not([type="checkbox"]):not([type="radio"])'))
  )
}

/** Stops Shift-click on row text from extending the browser's text selection. */
export function preventShiftTextSelection(event: MouseEvent) {
  if (event.shiftKey && !insideInteractive(event)) event.preventDefault()
}

/**
 * Tracks the last clicked row so a Shift-click can extend over the rows in between. The caller
 * applies the clicked row's new state to every returned id, like range selection in mail clients.
 */
export function useRangeSelection<Id>() {
  let anchor: Id | null = null

  function targets(id: Id, orderedIds: readonly Id[], extend: boolean): Id[] {
    const from = extend && anchor !== null ? orderedIds.indexOf(anchor) : -1
    const to = orderedIds.indexOf(id)
    anchor = id
    if (from === -1 || to === -1) return [id]
    return orderedIds.slice(Math.min(from, to), Math.max(from, to) + 1)
  }

  function reset() {
    anchor = null
  }

  return { targets, reset }
}

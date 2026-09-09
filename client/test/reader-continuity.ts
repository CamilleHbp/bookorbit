import { captureNativeAnchor, restoreNativeAnchor, type AnchorView } from '../src/features/reader/epub/composables/reader-native-anchor'
import type { EpubReadingRevision, ReadingAnchor } from '@bookorbit/types'

const output = document.querySelector('#results')!
const container = document.querySelector('#reader')!
type Reader = HTMLElement & AnchorView & { open: (book: unknown) => Promise<void>; close: () => void }
let view: Reader | undefined
const runButton = document.querySelector<HTMLButtonElement>('#run')!
const lines: string[] = []
const failures: string[] = []
function recordFailure(message: string) {
  if (failures.length < 10 && !failures.includes(message)) failures.push(message)
  report('Browser error recorded; this run cannot pass')
}
window.addEventListener('error', (event) => {
  recordFailure(`${event.message}\n${event.error?.stack ?? ''}`)
})
window.addEventListener('unhandledrejection', (event) => {
  recordFailure(String(event.reason))
})
function report(message: string) {
  output.textContent = [...lines, ...failures.map((failure) => `FAIL: ${failure}`), message].join('\n')
}
function passed(message: string) {
  lines.push(`PASS: ${message}`)
  report('')
}
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message)
}
const info = (revision: string): EpubReadingRevision => ({ bookId: 2, bookFileId: 9, libraryId: 5, revision, sha256: revision, sizeBytes: 0 })
async function open(name: string) {
  view?.close()
  view?.remove()
  report(`Loading renderer: ${name}`)
  await customElements.whenDefined('foliate-view')
  report(`Reading EPUB fixture: ${name}`)
  const response = await fetch(`/test/fixtures/revision-continuity/${name}.epub`)
  assert(response.ok, 'Generate the EPUB fixtures before running this test')
  const file = new File([await response.blob()], `${name}.epub`, { type: 'application/epub+zip' })
  report(`Parsing EPUB fixture: ${name}`)
  const book = await (window as unknown as { makeRevisionBook: (file: File) => Promise<unknown> }).makeRevisionBook(file)
  view = document.createElement('foliate-view') as Reader
  view.style.cssText = 'width:100%;height:100%;display:block;'
  container.append(view)
  report(`Rendering EPUB fixture: ${name}`)
  await view.open(book)
  return view
}
async function run() {
  lines.length = 0
  failures.length = 0
  report('Running')
  const first = await open('original')
  report('Loading chapter nine')
  const document = await first.book!.sections[8]!.createDocument!()
  const text = document.querySelectorAll('p')[19]!.firstChild!
  const range = document.createRange()
  range.setStart(text, 20)
  range.collapse(true)
  report('Navigating to chapter nine')
  await first.goTo(first.getCFI(8, range)!)
  const anchor = captureNativeAnchor(first, info('original'))!
  assert(anchor?.chapterIndex === 8 && anchor.quote, 'Capture chapter nine with native passage evidence')
  anchor.event = { id: crypto.randomUUID(), deviceId: 'browser-runtime', deviceSequence: 1, occurredAt: new Date().toISOString(), resetGeneration: 0 }
  const serialized = JSON.stringify(anchor)
  passed('Captured chapter nine with passage evidence')
  for (const name of ['appended', 'regenerated', 'edited', 'empty-chapter']) {
    const reader = await open(name)
    const acknowledgement = await restoreNativeAnchor(reader, anchor, info(name))
    assert(acknowledgement, `Native position verified in ${name}`)
    if (name === 'appended' || name === 'regenerated') {
      assert(acknowledgement!.quality === 'relocated', `Original passage relocated in ${name}: ${acknowledgement!.quality}`)
      if (name === 'appended') assert((reader.lastLocation!.fraction ?? 1) < anchor.bookFraction, 'Appended content lowers percentage')
    } else assert(acknowledgement!.quality === 'approximate', `Deleted text approximated in ${name}`)
    assert(JSON.stringify(anchor) === serialized, 'Restoration preserves the complete original event')
    passed(`${name}: ${acknowledgement!.quality}`)
  }
  const same = await open('original')
  const exact = await restoreNativeAnchor(same, anchor, info('original'))
  assert(exact?.quality === 'exact', 'Unchanged revision verifies the native location')
  passed('Unchanged revision: exact')

  const ending = await captureAt('original', 9, 39)
  const expanded = await open('appended')
  const boundary = await restoreNativeAnchor(expanded, ending, info('appended'))
  const expandedAnchor = captureNativeAnchor(expanded, info('appended'))
  assert(boundary?.quality === 'relocated' && expandedAnchor?.chapterIndex === 9, 'The old ending stays in chapter ten')
  assert(expandedAnchor!.bookFraction < 0.75, 'Appended chapters remain ahead of the old ending')
  passed('Old ending: chapter ten, appended chapters remain ahead')

  const legacy: ReadingAnchor = {
    schemaVersion: 1,
    bookId: 2,
    bookFileId: 9,
    revision: 'legacy',
    chapterIndex: 0,
    chapterFraction: 0,
    bookFraction: 0.5,
    event: anchor.event,
  }
  const legacyReader = await open('appended')
  const legacyAck = await restoreNativeAnchor(legacyReader, legacy, info('appended'))
  assert(legacyAck?.quality === 'approximate', 'Legacy progress is explicitly approximate')
  assert(captureNativeAnchor(legacyReader, info('appended'))?.quote, 'Legacy restoration permits capturing a stronger passage')
  passed('Legacy percentage: approximate, richer anchor available')

  const newer = await captureAt('appended', 13, 19)
  const newerSerialized = JSON.stringify(newer)
  const older = await open('original')
  const olderAck = await restoreNativeAnchor(older, newer, info('original'))
  assert(olderAck?.quality === 'approximate', 'A missing newer chapter projects approximately onto an older copy')
  assert(JSON.stringify(newer) === newerSerialized, 'Projection preserves the newer canonical anchor')
  passed('Older copy: valid approximation, newer canonical anchor preserved')

  const skipped = await open('regenerated')
  const skippedAck = await restoreNativeAnchor(skipped, newer, info('regenerated'))
  assert(skippedAck?.quality === 'relocated', 'A skipped revision finds the newer passage in reordered chapters')
  passed('Skipped revision: newer passage relocated')

  const rollback = await open('original')
  const rollbackAck = await restoreNativeAnchor(rollback, anchor, info('rollback-new-revision'))
  assert(rollbackAck?.quality === 'relocated', 'Rollback uses a new revision and restores the original passage')
  assert(JSON.stringify(anchor) === serialized && JSON.stringify(newer) === newerSerialized, 'Every projection preserves its original event')
  passed('Rollback: passage relocated under a new revision')
  report(failures.length ? 'FAIL: browser errors occurred; see details above' : 'PASS: expanded browser rendering continuity acceptance')
}
async function captureAt(name: string, chapter: number, paragraph: number): Promise<ReadingAnchor> {
  const reader = await open(name)
  const doc = await reader.book!.sections[chapter]!.createDocument!()
  const text = doc.querySelectorAll('p')[paragraph]!.firstChild!
  const range = doc.createRange()
  range.setStart(text, 20)
  range.collapse(true)
  await reader.goTo(reader.getCFI(chapter, range)!)
  const captured = captureNativeAnchor(reader, info(name))
  assert(captured?.chapterIndex === chapter && captured.quote, `Capture chapter ${chapter + 1} in ${name}`)
  captured!.event = {
    id: crypto.randomUUID(),
    deviceId: 'browser-runtime',
    deviceSequence: chapter + 2,
    occurredAt: new Date().toISOString(),
    resetGeneration: 0,
  }
  return captured!
}
runButton.addEventListener('click', () => {
  runButton.disabled = true
  void run()
    .catch((error: unknown) => {
      recordFailure(error instanceof Error ? (error.stack ?? error.message) : String(error))
    })
    .finally(() => {
      runButton.disabled = false
    })
})

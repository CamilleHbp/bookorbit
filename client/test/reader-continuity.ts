import { captureNativeAnchor, restoreNativeAnchor, type AnchorView } from '../src/features/reader/epub/composables/reader-native-anchor'
import type { EpubReadingRevision } from '@bookorbit/types'

const output = document.querySelector('#results')!
const container = document.querySelector('#reader')!
window.addEventListener('error', (event) => {
  output.textContent = `FAIL: ${event.message}\n${event.error?.stack ?? ''}`
})
window.addEventListener('unhandledrejection', (event) => {
  output.textContent = `FAIL: ${String(event.reason)}`
})
type Reader = HTMLElement & AnchorView & { open: (book: unknown) => Promise<void>; close: () => void }
let view: Reader | undefined
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message)
}
const info = (revision: string): EpubReadingRevision => ({ bookId: 2, bookFileId: 9, libraryId: 5, revision, sha256: revision, sizeBytes: 0 })
async function open(name: string) {
  view?.close()
  view?.remove()
  output.textContent = `Loading renderer: ${name}`
  await customElements.whenDefined('foliate-view')
  output.textContent = `Reading EPUB fixture: ${name}`
  const response = await fetch(`/test/fixtures/revision-continuity/${name}.epub`)
  assert(response.ok, 'Generate the EPUB fixtures before running this test')
  const file = new File([await response.blob()], `${name}.epub`, { type: 'application/epub+zip' })
  output.textContent = `Parsing EPUB fixture: ${name}`
  const book = await (window as unknown as { makeRevisionBook: (file: File) => Promise<unknown> }).makeRevisionBook(file)
  view = document.createElement('foliate-view') as Reader
  view.style.cssText = 'width:100%;height:100%;display:block;'
  container.append(view)
  output.textContent = `Rendering EPUB fixture: ${name}`
  await view.open(book)
  return view
}
async function run() {
  output.textContent = 'Running'
  const first = await open('original')
  output.textContent = 'Loading chapter nine'
  const document = await first.book!.sections[8]!.createDocument!()
  const text = document.querySelectorAll('p')[19]!.firstChild!
  const range = document.createRange()
  range.setStart(text, 20)
  range.collapse(true)
  output.textContent = 'Navigating to chapter nine'
  await first.goTo(first.getCFI(8, range)!)
  const anchor = captureNativeAnchor(first, info('original'))!
  assert(anchor?.chapterIndex === 8 && anchor.quote, 'Capture chapter nine with native passage evidence')
  anchor.event = { id: crypto.randomUUID(), deviceId: 'browser-runtime', deviceSequence: 1, occurredAt: new Date().toISOString(), resetGeneration: 0 }
  const serialized = JSON.stringify(anchor)
  const lines = ['Captured chapter nine']
  for (const name of ['appended', 'regenerated', 'edited', 'empty-chapter']) {
    const reader = await open(name)
    const acknowledgement = await restoreNativeAnchor(reader, anchor, info(name))
    assert(acknowledgement, `Native position verified in ${name}`)
    if (name === 'appended' || name === 'regenerated') {
      assert(acknowledgement!.quality === 'relocated', `Original passage relocated in ${name}: ${acknowledgement!.quality}`)
      if (name === 'appended') assert((reader.lastLocation!.fraction ?? 1) < anchor.bookFraction, 'Appended content lowers percentage')
    } else assert(acknowledgement!.quality === 'approximate', `Deleted text approximated in ${name}`)
    assert(JSON.stringify(anchor) === serialized, 'Restoration preserves the complete original event')
    lines.push(`${name}: ${acknowledgement!.quality}`)
    output.textContent = lines.join('\n')
  }
  output.textContent += '\nPASS: browser rendering continuity acceptance'
}
document.querySelector('#run')!.addEventListener('click', () => {
  void run().catch((error: unknown) => {
    output.textContent = `FAIL: ${error instanceof Error ? error.stack : String(error)}`
  })
})

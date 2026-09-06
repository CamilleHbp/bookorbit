import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

let loadFrameDocument: (
  frame: HTMLIFrameElement,
  src: string,
  render: (doc: Document) => void,
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<void>
beforeAll(async () => {
  const modulePath = '../../../../../public/assets/foliate/frame-load.js'
  ;({ loadFrameDocument } = await import(modulePath))
})
afterEach(() => vi.useRealTimers())

function frame() {
  const element = document.createElement('iframe')
  let current = document.implementation.createHTMLDocument()
  let url = 'about:blank'
  Object.defineProperty(element, 'contentDocument', { get: () => current })
  Object.defineProperty(element, 'src', {
    get: () => url,
    set: (value: string) => {
      url = value
    },
  })
  return {
    element,
    load(url: string) {
      current = document.implementation.createHTMLDocument()
      Object.defineProperty(current, 'URL', { value: url })
      element.dispatchEvent(new Event('load'))
      return current
    },
  }
}

describe('chapter frame navigation', () => {
  it('ignores the initial blank frame and renders the requested document once', async () => {
    const target = frame()
    const render = vi.fn<(doc: Document) => void>()
    const pending = loadFrameDocument(target.element, 'chapter.xhtml', render)
    target.load('about:blank')
    expect(render).not.toHaveBeenCalled()
    const doc = target.load('chapter.xhtml')
    await pending
    target.load('chapter.xhtml')
    expect(render).toHaveBeenCalledExactlyOnceWith(doc)
  })

  it('rejects rendering exceptions and removes the failed navigation', async () => {
    const target = frame()
    const pending = loadFrameDocument(target.element, 'chapter.xhtml', () => {
      throw new Error('Invalid chapter styles')
    })
    target.load('chapter.xhtml')
    await expect(pending).rejects.toThrow('Invalid chapter styles')
    expect(target.element.src).toBe('about:blank')
  })

  it('times out without allowing a late document to render', async () => {
    vi.useFakeTimers()
    const target = frame()
    const render = vi.fn<(doc: Document) => void>()
    const pending = loadFrameDocument(target.element, 'chapter.xhtml', render, { timeoutMs: 50 })
    await Promise.all([expect(pending).rejects.toThrow('timed out'), vi.advanceTimersByTimeAsync(50)])
    target.load('chapter.xhtml')
    expect(render).not.toHaveBeenCalled()
    expect(target.element.src).toBe('about:blank')
  })

  it('cancels superseded loads without applying their late position', async () => {
    const target = frame()
    const render = vi.fn<(doc: Document) => void>()
    const controller = new AbortController()
    const pending = loadFrameDocument(target.element, 'chapter.xhtml', render, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    target.load('chapter.xhtml')
    expect(render).not.toHaveBeenCalled()
  })

  it('rejects frame errors without waiting for the timeout', async () => {
    const target = frame()
    const pending = loadFrameDocument(target.element, 'chapter.xhtml', vi.fn<(doc: Document) => void>())
    target.element.dispatchEvent(new Event('error'))
    await expect(pending).rejects.toThrow('could not be loaded')
  })
})

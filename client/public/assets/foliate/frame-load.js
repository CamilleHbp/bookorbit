export const loadFrameDocument = (frame, src, render, { signal, timeoutMs = 5000 } = {}) =>
  new Promise((resolve, reject) => {
    let settled = false
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      frame.removeEventListener('load', loaded)
      frame.removeEventListener('error', failed)
      signal?.removeEventListener('abort', aborted)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      // Stop a timed-out navigation before its late load can replace the fallback.
      frame.src = 'about:blank'
      reject(error)
    }
    const failed = () => fail(new Error('Chapter frame could not be loaded'))
    const aborted = () => fail(new DOMException('Chapter navigation was cancelled', 'AbortError'))
    const loaded = () => {
      if (settled) return
      try {
        const doc = frame.contentDocument
        // Inserting an iframe can queue its initial blank load before navigation.
        if (doc?.URL === 'about:blank' && src !== 'about:blank') return
        if (!doc?.body) throw new Error('Chapter frame has no readable document')
        render(doc)
        if (settled) return
        settled = true
        cleanup()
        resolve()
      } catch (error) {
        fail(error)
      }
    }
    if (signal?.aborted) return aborted()
    signal?.addEventListener('abort', aborted, { once: true })
    frame.addEventListener('load', loaded)
    frame.addEventListener('error', failed)
    timer = setTimeout(() => fail(new Error('Chapter frame load timed out')), timeoutMs)
    try {
      frame.src = src
    } catch (error) {
      fail(error)
    }
  })

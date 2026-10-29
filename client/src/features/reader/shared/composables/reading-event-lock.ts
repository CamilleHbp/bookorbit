export function readingEventLockName(userId: number, fileId: number) {
  return `bookorbit-reading-copy:${userId}:${fileId}`
}

export function holdReadingEventLock(userId: number, fileId: number) {
  if (!navigator.locks) return { ready: Promise.resolve(), release: () => undefined }
  const controller = new AbortController()
  let release: () => void = () => undefined
  let resolveReady: () => void = () => undefined
  const lifetime = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  void navigator.locks
    .request(readingEventLockName(userId, fileId), { mode: 'shared', signal: controller.signal }, async () => {
      resolveReady()
      await lifetime
    })
    .catch(() => resolveReady())
  return {
    ready,
    release: () => {
      controller.abort()
      release()
      window.dispatchEvent(new Event('bookorbit-reading-events-changed'))
    },
  }
}

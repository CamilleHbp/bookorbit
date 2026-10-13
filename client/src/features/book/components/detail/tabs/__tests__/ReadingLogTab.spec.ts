import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createPinia } from 'pinia'
import { RouterLinkStub } from '@vue/test-utils'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import type { BookDetail, BookReadingSession, BookReadingSessionStats, KoreaderBookSyncInfo, ReadingAttempt } from '@bookorbit/types'

const mocks = vi.hoisted(() => ({
  api: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
  hasPermission: vi.fn<(...args: unknown[]) => boolean>(),
}))

vi.mock('@/lib/api', () => ({
  api: mocks.api,
}))

vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: mocks.hasPermission }),
}))

vi.mock('vue-echarts', () => ({
  default: { name: 'VChart', template: '<div />' },
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: { template: '<div><slot /></div>' },
  DropdownMenuContent: { template: '<div><slot /></div>' },
  DropdownMenuItem: { template: '<button type="button"><slot /></button>' },
  DropdownMenuTrigger: { template: '<div><slot /></div>' },
}))

import ReadingLogTab from '../ReadingLogTab.vue'
import ResetReadingStateDialog from '@/features/book/components/ResetReadingStateDialog.vue'

function makeBook(overrides: Partial<BookDetail> = {}): BookDetail {
  return {
    id: 10,
    libraryId: 1,
    libraryName: 'My Library',
    status: 'ok',
    folderPath: '/books',
    addedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: null,
    title: 'Test Book',
    subtitle: null,
    description: null,
    isbn10: null,
    isbn13: null,
    publisher: null,
    publishedDate: null,
    publishedYear: null,
    language: null,
    pageCount: null,
    seriesName: null,
    seriesIndex: null,
    rating: null,
    personalNote: null,
    personalNoteUpdatedAt: null,
    communityRatings: [],
    coverSource: null,
    coverMedia: [],
    covers: { ebook: null, audio: null },
    coverVersion: 'legacy:2024-01-01T00:00:00.000Z',
    hardcoverEditionId: null,
    providerIds: {},
    authors: [],
    genres: [],
    tags: [],
    files: [],
    lastWrittenAt: null,
    metadataScore: null,
    readStatus: null,
    audioMetadata: null,
    readAloudSync: {
      mode: 'auto',
      state: 'unavailable',
      unavailableReason: 'no_media_overlay_epub',
      overlayFileId: null,
      audioDurationSeconds: null,
      overlayDurationSeconds: null,
      durationDifferenceSeconds: null,
      durationDifferenceRatio: null,
      koreaderDownloadAvailable: false,
    },
    formatPriority: [],
    comicMetadata: null,
    customMetadata: [],
    lockedFields: [],
    collections: [],
    ...overrides,
  }
}

function makeBookFile(overrides: Partial<BookDetail['files'][number]> = {}): BookDetail['files'][number] {
  return {
    id: 1,
    format: 'epub',
    role: 'primary',
    sizeBytes: 1,
    absolutePath: '/book.epub',
    createdAt: '2026-01-01T00:00:00.000Z',
    filename: 'book.epub',
    durationSeconds: null,
    ...overrides,
  }
}

function makeSession(overrides: Partial<BookReadingSession> = {}): BookReadingSession {
  return {
    id: 1,
    bookFileId: 17,
    startedAt: '2026-04-15T10:00:00.000Z',
    endedAt: '2026-04-15T10:30:00.000Z',
    durationSeconds: 1800,
    progressDelta: 5.5,
    endProgress: 42,
    format: 'epub',
    source: 'web',
    attemptId: null,
    ...overrides,
  }
}

function makeStats(items: BookReadingSession[]): BookReadingSessionStats {
  return {
    totalSessions: items.length,
    totalSeconds: 0,
    avgDurationSeconds: 0,
    firstSessionAt: null,
    lastSessionAt: null,
    dailySummary: [],
    paceProgressDelta: 0,
    paceDurationSeconds: 0,
    progressSummary: [],
    latestEndProgress: null,
    bySource: [],
    longestSessionSeconds: 0,
    longestSessionAt: null,
    backtrackCount: 0,
  }
}

function makeAttempt(overrides: Partial<ReadingAttempt> = {}): ReadingAttempt {
  return {
    id: 1,
    bookId: 10,
    startedOn: '2026-09-07',
    endedOn: null,
    outcome: null,
    origin: 'koreader',
    externalProvider: null,
    externalId: null,
    totalSessions: 0,
    totalSeconds: 0,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    ...overrides,
  }
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

function makeKoreaderProgress(overrides: Partial<KoreaderBookSyncInfo> = {}): KoreaderBookSyncInfo {
  return {
    bookId: 10,
    bookFileId: 17,
    canonicalPercentage: 0,
    canonicalChapterIndex: null,
    canonicalChapterTitle: null,
    canonicalSource: 'web_reader',
    canonicalUpdatedAt: '1970-01-01T00:00:00.000Z',
    devices: [],
    fileModifiedSinceLastSync: false,
    heldByReset: [],
    ...overrides,
  }
}

const HELD_KINDLE = { device: 'Kindle', deviceId: 'kindle-1', percentage: 26.67, updatedAt: '2026-10-12T00:00:00.000Z' }

/** Routes each request the tab makes on mount: sessions, attempts, the progress reads and KOReader holds. */
function routeApi(options: { sessions?: BookReadingSession[]; attempts?: ReadingAttempt[]; koreader?: () => KoreaderBookSyncInfo } = {}) {
  const sessions = options.sessions ?? []
  const attempts = options.attempts ?? []
  return (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/koreader/books/')) return Promise.resolve(jsonResponse(options.koreader?.() ?? makeKoreaderProgress()))
    if (url.includes('/reading-attempts')) return Promise.resolve(jsonResponse({ items: attempts, page: 1, pageSize: 50, total: attempts.length }))
    if (url.includes('/sessions')) {
      return Promise.resolve(jsonResponse({ items: sessions, total: sessions.length, page: 1, pageSize: 25, stats: makeStats(sessions) }))
    }
    if (url.includes('/progress')) return Promise.resolve(jsonResponse([]))
    return Promise.resolve(jsonResponse({}))
  }
}

function mountTab(book = makeBook()) {
  return mount(ReadingLogTab, {
    props: { book },
    global: { plugins: [createPinia()], stubs: { RouterLink: RouterLinkStub } },
  })
}

describe('ReadingLogTab', () => {
  beforeEach(() => {
    mocks.api.mockReset()
    mocks.api.mockImplementation(routeApi())
    mocks.hasPermission.mockReset()
    mocks.hasPermission.mockReturnValue(true)
    localStorage.clear()
  })

  it('shows one explanation instead of four empty panels when nothing is logged', async () => {
    const wrapper = mountTab()
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('Nothing logged for this book yet')
    expect(text).toContain('Sync KOReader')
    expect(text).not.toContain('No sessions recorded yet')
  })

  it('renders the ledger, attempts and band once the book has sessions', async () => {
    mocks.api.mockImplementation(routeApi({ sessions: [makeSession()] }))
    const wrapper = mountTab()
    await flushPromises()

    const text = wrapper.text()
    expect(text).not.toContain('Nothing logged for this book yet')
    expect(text).toContain('Sessions')
    expect(text).toContain('Attempts')
    expect(text).toContain('Progress over time')
  })

  it('renders the quick filter buttons', async () => {
    mocks.api.mockImplementation(routeApi({ sessions: [makeSession()] }))
    const wrapper = mountTab()
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('All time')
    expect(text).toContain('Last 30 days')
    expect(text).toContain('Last 90 days')
    expect(text).toContain('This year')
  })

  it('shows a projected UTC-midnight lifecycle date on its canonical day west of UTC', async () => {
    const originalTimeZone = process.env.TZ
    process.env.TZ = 'America/Sao_Paulo'
    try {
      mocks.api.mockImplementation(routeApi({ attempts: [makeAttempt()] }))
      const wrapper = mountTab(
        makeBook({
          readStatus: {
            status: 'reading',
            source: 'auto',
            startedAt: '2026-09-07T00:00:00.000Z',
            finishedAt: null,
            updatedAt: '2026-09-07T00:00:00.000Z',
          },
        }),
      )
      await flushPromises()

      const startedDate = wrapper.get('button[aria-label="Edit the date you started this book"]')
      expect(new Date('2026-09-07T00:00:00.000Z').getDate()).toBe(6)
      expect(startedDate.text()).toContain('Sep 7, 2026')
      expect(startedDate.text()).not.toContain('Sep 6, 2026')
    } finally {
      process.env.TZ = originalTimeZone
    }
  })

  it('narrows the session request when a quick filter is chosen', async () => {
    mocks.api.mockImplementation(routeApi({ sessions: [makeSession()] }))
    const wrapper = mountTab()
    await flushPromises()

    mocks.api.mockClear()
    const last30 = wrapper.findAll('button').find((button) => button.text() === 'Last 30 days')
    await last30!.trigger('click')
    await flushPromises()

    const lastCall = mocks.api.mock.calls[mocks.api.mock.calls.length - 1]?.[0] as string
    expect(lastCall).toContain('dateFrom=')
  })

  it('drops the date filter again on all time', async () => {
    mocks.api.mockImplementation(routeApi({ sessions: [makeSession()] }))
    const wrapper = mountTab()
    await flushPromises()

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Last 90 days')!
      .trigger('click')
    await flushPromises()
    mocks.api.mockClear()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'All time')!
      .trigger('click')
    await flushPromises()

    const lastCall = mocks.api.mock.calls[mocks.api.mock.calls.length - 1]?.[0] as string
    expect(lastCall).not.toContain('dateFrom=')
  })

  it('offers a format filter only when the book has more than one format', async () => {
    mocks.api.mockImplementation(routeApi({ sessions: [makeSession()] }))
    const single = mountTab(makeBook({ files: [makeBookFile({ id: 1, format: 'epub', filename: 'a.epub', absolutePath: '/a.epub' })] }))
    await flushPromises()
    expect(single.find('select').exists()).toBe(false)

    const multiple = mountTab(
      makeBook({
        files: [
          makeBookFile({ id: 1, format: 'epub', filename: 'a.epub', absolutePath: '/a.epub' }),
          makeBookFile({ id: 2, format: 'pdf', filename: 'a.pdf', absolutePath: '/a.pdf' }),
        ],
      }),
    )
    await flushPromises()
    expect(multiple.find('select').exists()).toBe(true)
  })

  it('reloads the log and the attempts after a reading state reset', async () => {
    mocks.api.mockImplementation(routeApi({ sessions: [makeSession()] }))
    const wrapper = mountTab()
    await flushPromises()

    const resetButton = wrapper.findAll('button').find((button) => button.text() === 'Reset reading state')
    expect(resetButton).toBeDefined()
    await resetButton!.trigger('click')

    const dialog = wrapper.findComponent(ResetReadingStateDialog)
    expect(dialog.props('open')).toBe(true)

    const readStatus = {
      status: 'unread',
      source: 'manual',
      startedAt: null,
      finishedAt: null,
      updatedAt: '2026-07-09T12:00:00.000Z',
    }
    mocks.api.mockReset()
    mocks.api.mockImplementation((input) => {
      const url = String(input)
      if (url.includes('reset-reading-state')) return Promise.resolve(jsonResponse({ readStatus }))
      return routeApi({ sessions: [makeSession()] })(input)
    })

    dialog.vm.$emit('confirm')
    await flushPromises()

    const urls = mocks.api.mock.calls.map((call) => String(call[0]))
    expect(urls[0]).toBe('/api/v1/books/10/reset-reading-state')
    expect(urls.some((url) => url.includes('/api/v1/books/10/sessions?'))).toBe(true)
    expect(urls.some((url) => url.includes('/api/v1/books/10/reading-attempts'))).toBe(true)
    expect(wrapper.emitted('saved')?.[0]).toEqual([expect.objectContaining({ readStatus })])
  })

  describe('KOReader reset hold', () => {
    function holdRows(wrapper: ReturnType<typeof mountTab>) {
      return wrapper.findAll('[data-testid="koreader-reset-hold"]')
    }

    it('explains a held device inside the vitals card', async () => {
      mocks.api.mockImplementation(
        routeApi({
          sessions: [makeSession({ source: 'koreader', endProgress: 26.67 })],
          koreader: () => makeKoreaderProgress({ heldByReset: [HELD_KINDLE] }),
        }),
      )
      const wrapper = mountTab()
      await flushPromises()

      expect(mocks.api).toHaveBeenCalledWith('/api/v1/koreader/books/10/progress')
      const vitals = wrapper.get('section[aria-label]')
      const rows = vitals.findAll('[data-testid="koreader-reset-hold"]')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.text()).toContain('Kindle still has the old position (27%)')
      expect(rows[0]!.text()).toContain("Use this device's position")
    })

    it('shows the notice on an otherwise blank log, where a reset leaves it', async () => {
      mocks.api.mockImplementation(routeApi({ koreader: () => makeKoreaderProgress({ heldByReset: [HELD_KINDLE] }) }))
      const wrapper = mountTab()
      await flushPromises()

      expect(wrapper.text()).toContain('Nothing logged for this book yet')
      expect(holdRows(wrapper)).toHaveLength(1)
    })

    it('shows nothing when no device is held', async () => {
      mocks.api.mockImplementation(routeApi({ sessions: [makeSession()] }))
      const wrapper = mountTab()
      await flushPromises()

      expect(holdRows(wrapper)).toHaveLength(0)
      expect(wrapper.text()).not.toContain('still has the old position')
    })

    it('neither asks for nor shows holds without the KOReader permission', async () => {
      mocks.hasPermission.mockImplementation((permission) => permission !== 'koreader_sync')
      mocks.api.mockImplementation(routeApi({ sessions: [makeSession()], koreader: () => makeKoreaderProgress({ heldByReset: [HELD_KINDLE] }) }))
      const wrapper = mountTab()
      await flushPromises()

      expect(mocks.api.mock.calls.some((call) => String(call[0]).includes('/koreader/'))).toBe(false)
      expect(holdRows(wrapper)).toHaveLength(0)
    })

    it('ignores a hold answered for a different book', async () => {
      mocks.api.mockImplementation(
        routeApi({ sessions: [makeSession()], koreader: () => makeKoreaderProgress({ bookId: 99, heldByReset: [HELD_KINDLE] }) }),
      )
      const wrapper = mountTab()
      await flushPromises()

      expect(holdRows(wrapper)).toHaveLength(0)
    })

    it('checks for a hold again once a reset from this tab completes', async () => {
      let held: (typeof HELD_KINDLE)[] = []
      mocks.api.mockImplementation((input) => {
        const url = String(input)
        if (url.includes('reset-reading-state')) {
          held = [HELD_KINDLE]
          return Promise.resolve(
            jsonResponse({
              readStatus: { status: 'unread', source: 'manual', startedAt: null, finishedAt: null, updatedAt: '2026-10-12T00:00:00.000Z' },
            }),
          )
        }
        return routeApi({ sessions: [makeSession()], koreader: () => makeKoreaderProgress({ heldByReset: held }) })(input)
      })
      const wrapper = mountTab()
      await flushPromises()
      expect(holdRows(wrapper)).toHaveLength(0)

      wrapper.findComponent(ResetReadingStateDialog).vm.$emit('confirm')
      await flushPromises()

      expect(holdRows(wrapper)).toHaveLength(1)
    })

    it('accepts the device position and refreshes everything it moves', async () => {
      let held = [HELD_KINDLE]
      mocks.api.mockImplementation((input) => {
        const url = String(input)
        if (url.endsWith('/reset-hold/release')) {
          held = []
          return Promise.resolve({ ok: true, status: 204, json: async () => ({}) } as Response)
        }
        if (url === '/api/v1/books/10/progress') return Promise.resolve(jsonResponse(held.length ? [] : [{ fileId: 17, percentage: 26.67 }]))
        return routeApi({ sessions: [makeSession({ source: 'koreader' })], koreader: () => makeKoreaderProgress({ heldByReset: held }) })(input)
      })
      const wrapper = mountTab()
      await flushPromises()
      mocks.api.mockClear()

      await holdRows(wrapper)[0]!.get('button').trigger('click')
      await flushPromises()

      const releaseCall = mocks.api.mock.calls.find((call) => String(call[0]).endsWith('/reset-hold/release'))
      expect(releaseCall?.[0]).toBe('/api/v1/koreader/books/10/reset-hold/release')
      expect(releaseCall?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ deviceId: 'kindle-1' }) })

      const urls = mocks.api.mock.calls.map((call) => String(call[0]))
      expect(urls).toContain('/api/v1/books/10/progress')
      expect(urls.some((url) => url.startsWith('/api/v1/books/10/sessions?'))).toBe(true)
      expect(urls.some((url) => url.includes('/api/v1/books/10/reading-attempts'))).toBe(true)
      expect(wrapper.emitted('refetch')).toHaveLength(1)
      expect(holdRows(wrapper)).toHaveLength(0)
      expect(wrapper.get('section[aria-label]').text()).toContain('27%')
    })

    it('keeps the notice and reports the failure when the release is refused', async () => {
      mocks.api.mockImplementation((input) => {
        if (String(input).endsWith('/reset-hold/release')) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response)
        return routeApi({ sessions: [makeSession()], koreader: () => makeKoreaderProgress({ heldByReset: [HELD_KINDLE] }) })(input)
      })
      const wrapper = mountTab()
      await flushPromises()

      await holdRows(wrapper)[0]!.get('button').trigger('click')
      await flushPromises()

      expect(holdRows(wrapper)).toHaveLength(1)
      expect(wrapper.get('[role="alert"]').text()).toBe('Could not use this position. Try again.')
      expect(wrapper.emitted('refetch')).toBeUndefined()
    })

    it('rechecks the hold when the kept-alive tab is shown again', async () => {
      let held: (typeof HELD_KINDLE)[] = []
      mocks.api.mockImplementation(routeApi({ sessions: [makeSession()], koreader: () => makeKoreaderProgress({ heldByReset: held }) }))
      const visible = ref(true)
      const Host = defineComponent({
        setup() {
          return () => h(KeepAlive, null, [visible.value ? h(ReadingLogTab, { book: makeBook() }) : h('div')])
        },
      })
      const wrapper = mount(Host, { global: { plugins: [createPinia()], stubs: { RouterLink: RouterLinkStub } } })
      await flushPromises()
      expect(holdRows(wrapper as unknown as ReturnType<typeof mountTab>)).toHaveLength(0)

      held = [HELD_KINDLE]
      visible.value = false
      await nextTick()
      visible.value = true
      await flushPromises()

      expect(holdRows(wrapper as unknown as ReturnType<typeof mountTab>)).toHaveLength(1)
    })
  })

  it('hides the reset action without the metadata-edit permission', async () => {
    mocks.hasPermission.mockReturnValue(false)
    mocks.api.mockImplementation(routeApi({ sessions: [makeSession()] }))
    const wrapper = mountTab()
    await flushPromises()

    expect(wrapper.findAll('button').some((button) => button.text() === 'Reset reading state')).toBe(false)
  })
})

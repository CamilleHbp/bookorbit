import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAnnotations, type Annotation } from '../useAnnotations'

interface ApiResponse {
  ok: boolean
  json: () => Promise<unknown>
}

const apiMock = vi.hoisted(() => vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<ApiResponse>>())

vi.mock('@/lib/api', () => ({
  api: apiMock,
}))

function makeAnnotation(id: number, cfi = `epubcfi(/6/${id})`): Annotation {
  return {
    id,
    bookId: 9,
    cfi,
    jumpFileId: 33,
    pageno: null,
    text: `Selection ${id}`,
    color: '#FACC15',
    style: 'highlight',
    note: null,
    chapterTitle: 'Intro',
    origin: 'web',
    positionStatus: 'exact',
    chapterIndex: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function response(ok: boolean, payload: unknown = null): ApiResponse {
  return {
    ok,
    json: async () => payload,
  }
}

describe('useAnnotations', () => {
  it('keeps projected highlights and links after a metadata edit while preserving the source', async () => {
    const store = useAnnotations()
    const original = makeAnnotation(1)
    original.sourceAnchor = { revision: 'old', bookId: 9, bookFileId: 33, chapterIndex: 0, chapterFraction: 0, bookFraction: 0, quote: original.text }
    store.annotations.value = [original]
    await store.projectForFile(33, async () => ({ cfi: 'mapped', positionStatus: 'repaired' }))
    expect(store.projectedTarget(original.cfi!)).toBe('mapped')
    apiMock.mockResolvedValueOnce(response(true, { ...original, note: 'Edited note' }))
    const edited = await store.update(9, 1, { note: 'Edited note' })
    expect(edited).toMatchObject({ cfi: 'mapped', positionStatus: 'repaired', note: 'Edited note', sourceAnchor: original.sourceAnchor })
    expect(JSON.parse(apiMock.mock.calls.at(-1)![1]!.body as string)).toEqual({ note: 'Edited note' })
  })

  it('bounds annotation resolution work and disables unresolved old links', async () => {
    const store = useAnnotations()
    store.annotations.value = Array.from({ length: 105 }, (_, i) => ({
      ...makeAnnotation(i + 1),
      sourceAnchor: { revision: 'old', chapterIndex: 0, chapterFraction: 0, bookFraction: 0 },
    }))
    let calls = 0
    await store.projectForFile(33, async () => {
      calls++
      return { cfi: 'mapped', positionStatus: 'repaired' }
    })
    expect(calls).toBeLessThanOrEqual(100)
    expect(store.annotations.value[104]).toMatchObject({ cfi: null, positionStatus: 'pending' })
    expect(store.projectedTarget('epubcfi(/6/105)')).toBeNull()
  })

  it('draws only verified locations belonging to the open file and keeps unresolved notes available', () => {
    const store = useAnnotations()
    store.annotations.value = [
      makeAnnotation(1),
      { ...makeAnnotation(2), jumpFileId: 44 },
      { ...makeAnnotation(3), positionStatus: 'pending' },
      { ...makeAnnotation(4), positionStatus: 'failed' },
      { ...makeAnnotation(5), jumpFileId: null },
    ]
    expect(store.drawableForFile(33).map((annotation) => annotation.id)).toEqual([1, 5])
    expect(store.hasUnverifiedForFile(33)).toBe(true)
    expect(store.hasUnverifiedForFile(44)).toBe(false)
    expect(store.annotations.value).toHaveLength(5)
  })

  beforeEach(() => {
    apiMock.mockReset()
  })

  it('loads annotations when API succeeds', async () => {
    const list = [makeAnnotation(1), makeAnnotation(2)]
    apiMock.mockResolvedValueOnce(response(true, list))

    const store = useAnnotations()
    await store.load(9)

    expect(apiMock).toHaveBeenCalledWith('/api/v1/books/9/annotations')
    expect(store.loadError.value).toBeNull()
    expect(store.annotations.value).toEqual(list)
  })

  it('sets loadError when loading annotations fails', async () => {
    apiMock.mockResolvedValueOnce(response(false))

    const store = useAnnotations()
    await store.load(9)

    expect(store.loadError.value).toBe('Failed to load')
    expect(store.annotations.value).toEqual([])
  })

  it('creates and appends annotation on success', async () => {
    const created = makeAnnotation(3)
    const createdCfi = created.cfi ?? 'epubcfi(/6/3)'
    apiMock.mockResolvedValueOnce(response(true, created))

    const store = useAnnotations()
    const result = await store.create(9, {
      cfi: createdCfi,
      text: created.text,
      color: created.color,
      style: created.style,
      note: 'test',
      chapterTitle: 'Chapter 1',
    })

    const [url, req] = apiMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/books/9/annotations')
    expect(req.method).toBe('POST')
    expect(JSON.parse(String(req.body))).toEqual({
      cfi: createdCfi,
      text: created.text,
      color: created.color,
      style: created.style,
      note: 'test',
      chapterTitle: 'Chapter 1',
    })
    expect(result).toEqual(created)
    expect(store.annotations.value).toEqual([created])
  })

  it('returns null and does not append annotation on create failure', async () => {
    apiMock.mockResolvedValueOnce(response(false))

    const store = useAnnotations()
    const result = await store.create(9, {
      cfi: 'epubcfi(/6/18)',
      text: 'x',
      color: '#fff',
      style: 'highlight',
    })

    expect(result).toBeNull()
    expect(store.annotations.value).toEqual([])
  })

  it('updates only the target annotation when updateNote succeeds', async () => {
    const existing = [makeAnnotation(1), makeAnnotation(2)]
    const updated = { ...existing[1]!, note: 'New note' }
    apiMock.mockResolvedValueOnce(response(true, updated))

    const store = useAnnotations()
    store.annotations.value = existing

    await store.updateNote(9, 2, 'New note')

    const [url, req] = apiMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/books/9/annotations/2')
    expect(req.method).toBe('PATCH')
    expect(JSON.parse(String(req.body))).toEqual({ note: 'New note' })
    expect(store.annotations.value).toEqual([existing[0], updated])
  })

  it('patches color and style without appending a duplicate annotation', async () => {
    const existing = [makeAnnotation(1), makeAnnotation(2)]
    const updated = { ...existing[0]!, color: '#38BDF8', style: 'underline' }
    apiMock.mockResolvedValueOnce(response(true, updated))

    const store = useAnnotations()
    store.annotations.value = existing

    const result = await store.update(9, 1, { color: '#38BDF8', style: 'underline' })

    const [url, req] = apiMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/books/9/annotations/1')
    expect(req.method).toBe('PATCH')
    expect(JSON.parse(String(req.body))).toEqual({ color: '#38BDF8', style: 'underline' })
    expect(result).toEqual(updated)
    expect(store.annotations.value).toEqual([updated, existing[1]])
  })

  it('returns null and leaves local annotations unchanged when update fails', async () => {
    const existing = [makeAnnotation(1), makeAnnotation(2)]
    apiMock.mockResolvedValueOnce(response(false))

    const store = useAnnotations()
    store.annotations.value = existing

    const result = await store.update(9, 1, { color: '#38BDF8' })

    expect(result).toBeNull()
    expect(store.annotations.value).toEqual(existing)
  })

  it('removes annotation when delete succeeds', async () => {
    apiMock.mockResolvedValueOnce(response(true))

    const store = useAnnotations()
    store.annotations.value = [makeAnnotation(1), makeAnnotation(2)]

    await store.remove(9, 1)

    expect(apiMock).toHaveBeenCalledWith('/api/v1/books/9/annotations/1', { method: 'DELETE' })
    expect(store.annotations.value.map((a) => a.id)).toEqual([2])
  })
})

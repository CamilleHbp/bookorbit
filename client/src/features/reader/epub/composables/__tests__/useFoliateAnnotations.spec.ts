import { describe, expect, it, vi } from 'vitest'
import { useFoliateAnnotations } from '../useFoliateAnnotations'

describe('useFoliateAnnotations', () => {
  it('keeps rejected locators pending without reviving an annotation removed during resolution', async () => {
    const anns = useFoliateAnnotations()
    const view = { addAnnotation: vi.fn<(annotation: { value: string }) => Promise<unknown>>().mockRejectedValue(new Error('Missing chapter')) }
    anns.addAnnotation(view, 'epubcfi(/6/2)', 'yellow', 'highlight', 'Selected text')
    await Promise.resolve()
    expect(anns.pendingAnnotationCount.value).toBe(1)
    anns.deleteAnnotation(null, 'epubcfi(/6/2)')
    anns.addAnnotation(view, 'epubcfi(/6/4)', 'yellow', 'highlight', 'Selected text')
    anns.deleteAnnotation(null, 'epubcfi(/6/4)')
    await Promise.resolve()
    expect(anns.pendingAnnotationCount.value).toBe(0)
  })

  it('withholds a reused locator until its installed text is verified, including after restyling', () => {
    const anns = useFoliateAnnotations()
    const draw = vi.fn<(drawer: unknown, options: { color: string }) => void>()
    const document = new DOMParser().parseFromString('<p>Unrelated replacement text</p>', 'text/html')
    const range = document.createRange()
    range.selectNodeContents(document.body)
    const event = () => new CustomEvent('draw-annotation', { detail: { draw, annotation: { value: 'epubcfi(/6/2)' }, range } })
    anns.addAnnotations(null, [{ cfi: 'epubcfi(/6/2)', color: 'yellow', style: 'highlight', text: 'Original selected passage' }])
    anns.handleDrawAnnotationEvent(event())
    expect(draw).not.toHaveBeenCalled()
    expect(anns.pendingAnnotationCount.value).toBe(1)
    anns.redrawAnnotation(null, 'epubcfi(/6/2)', 'blue', 'underline')
    anns.handleDrawAnnotationEvent(event())
    expect(draw).not.toHaveBeenCalled()
    document.body.textContent = 'Original selected passage'
    range.selectNodeContents(document.body)
    anns.handleDrawAnnotationEvent(event())
    expect(draw).toHaveBeenCalledOnce()
    expect(anns.pendingAnnotationCount.value).toBe(0)
  })

  it('stores style metadata and calls view.addAnnotation for single add', () => {
    const view = { addAnnotation: vi.fn<(arg: { value: string }) => void>() }
    const anns = useFoliateAnnotations()

    anns.addAnnotation(view, 'epubcfi(/6/2)', '#38BDF8', 'underline')

    expect(anns.annotationStyleMap.get('epubcfi(/6/2)')).toEqual({ color: '#38BDF8', style: 'underline' })
    expect(view.addAnnotation).toHaveBeenCalledWith({ value: 'epubcfi(/6/2)' })
  })

  it('adds and deletes multiple annotations against foliate view', () => {
    const view = {
      addAnnotation: vi.fn<(arg: { value: string }) => void>(),
      deleteAnnotation: vi.fn<(arg: { value: string }) => void>(),
    }
    const anns = useFoliateAnnotations()

    anns.addAnnotations(view, [
      { cfi: 'epubcfi(/6/4)', color: '#4ADE80', style: 'highlight' },
      { cfi: 'epubcfi(/6/6)', color: '#FB923C', style: 'strikethrough' },
    ])
    anns.deleteAnnotation(view, 'epubcfi(/6/4)')

    expect(view.addAnnotation).toHaveBeenCalledTimes(2)
    expect(view.deleteAnnotation).toHaveBeenCalledWith({ value: 'epubcfi(/6/4)' })
    expect(anns.annotationStyleMap.has('epubcfi(/6/4)')).toBe(false)
    expect(anns.annotationStyleMap.get('epubcfi(/6/6)')).toEqual({ color: '#FB923C', style: 'strikethrough' })
  })

  it('redraws an existing annotation by deleting then re-adding it with updated style metadata', () => {
    const view = {
      addAnnotation: vi.fn<(arg: { value: string }) => void>(),
      deleteAnnotation: vi.fn<(arg: { value: string }) => void>(),
    }
    const anns = useFoliateAnnotations()

    anns.addAnnotation(view, 'epubcfi(/6/4)', '#FACC15', 'highlight')
    view.addAnnotation.mockClear()

    anns.redrawAnnotation(view, 'epubcfi(/6/4)', '#38BDF8', 'underline')

    expect(anns.annotationStyleMap.get('epubcfi(/6/4)')).toEqual({ color: '#38BDF8', style: 'underline' })
    expect(view.deleteAnnotation).toHaveBeenCalledWith({ value: 'epubcfi(/6/4)' })
    expect(view.addAnnotation).toHaveBeenCalledWith({ value: 'epubcfi(/6/4)' })
    expect(view.deleteAnnotation.mock.invocationCallOrder[0]!).toBeLessThan(view.addAnnotation.mock.invocationCallOrder[0]!)
  })

  it('re-adds all known annotations after renderer reload', () => {
    vi.useFakeTimers()
    const view = { addAnnotation: vi.fn<(arg: { value: string }) => void>() }
    const anns = useFoliateAnnotations()

    anns.addAnnotation(null, 'epubcfi(/6/8)', '#FACC15', 'highlight')
    anns.addAnnotation(null, 'epubcfi(/6/10)', '#F472B6', 'squiggly')

    anns.reAddAll(view)
    vi.advanceTimersByTime(100)

    expect(view.addAnnotation).toHaveBeenCalledWith({ value: 'epubcfi(/6/8)' })
    expect(view.addAnnotation).toHaveBeenCalledWith({ value: 'epubcfi(/6/10)' })
    expect(view.addAnnotation).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  it('hydrates draw callback using stored style/color', () => {
    const anns = useFoliateAnnotations()
    const draw = vi.fn<(drawer: unknown, options: { color: string }) => void>()

    anns.addAnnotation(null, 'epubcfi(/6/12)', '#FB923C', 'underline')
    anns.handleDrawAnnotationEvent(
      new CustomEvent('draw-annotation', {
        detail: {
          draw,
          annotation: { value: 'epubcfi(/6/12)' },
        },
      }),
    )

    expect(draw).toHaveBeenCalledTimes(1)
    expect(draw).toHaveBeenCalledWith(expect.any(Function), { color: '#FB923C' })

    const drawer = draw.mock.calls[0]?.[0] as (rects: DOMRectList, opts?: { color?: string }) => SVGElement
    const rects = [{ left: 1, top: 2, bottom: 8, width: 10, height: 6 }] as unknown as DOMRectList
    const node = drawer(rects, { color: '#FB923C' })
    expect(node.tagName.toLowerCase()).toBe('g')
    expect(node.getAttribute('fill')).toBe('#FB923C')
  })
})

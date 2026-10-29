import { computed, ref } from 'vue'
import { verifiesAnnotationRange } from './annotation-range'

export interface AnnotationEntry {
  color: string
  style: string
  text?: string
}

export function useFoliateAnnotations() {
  const annotationStyleMap = new Map<string, AnnotationEntry>()
  const pending = ref(new Set<string>())

  function createSVG(tag: string): SVGElement {
    return document.createElementNS('http://www.w3.org/2000/svg', tag)
  }

  function getDrawFunction(style: string) {
    switch (style) {
      case 'underline':
        return (rects: DOMRectList, { color = 'red' }: { color?: string } = {}) => {
          const g = createSVG('g')
          g.setAttribute('fill', color)
          for (const { left, bottom, width } of Array.from(rects)) {
            const el = createSVG('rect')
            el.setAttribute('x', String(left))
            el.setAttribute('y', String(bottom - 2))
            el.setAttribute('height', '2')
            el.setAttribute('width', String(width))
            g.append(el)
          }
          return g
        }
      case 'strikethrough':
        return (rects: DOMRectList, { color = 'red' }: { color?: string } = {}) => {
          const g = createSVG('g')
          g.setAttribute('fill', color)
          for (const { left, top, bottom, width } of Array.from(rects)) {
            const el = createSVG('rect')
            el.setAttribute('x', String(left))
            el.setAttribute('y', String((top + bottom) / 2))
            el.setAttribute('height', '2')
            el.setAttribute('width', String(width))
            g.append(el)
          }
          return g
        }
      case 'invert':
        return (rects: DOMRectList, { color = '#FFFFFF' }: { color?: string } = {}) => {
          const g = createSVG('g')
          g.setAttribute('fill', color)
          ;(g as SVGElement).style.mixBlendMode = 'difference'
          for (const { left, top, height, width } of Array.from(rects)) {
            const el = createSVG('rect')
            el.setAttribute('x', String(left))
            el.setAttribute('y', String(top))
            el.setAttribute('height', String(height))
            el.setAttribute('width', String(width))
            g.append(el)
          }
          return g
        }
      case 'squiggly':
        return (rects: DOMRectList, { color = 'red' }: { color?: string } = {}) => {
          const g = createSVG('g')
          g.setAttribute('fill', 'none')
          g.setAttribute('stroke', color)
          g.setAttribute('stroke-width', '2')
          const block = 3
          for (const { left, bottom, width } of Array.from(rects)) {
            const el = createSVG('path')
            const n = Math.round(width / block / 1.5)
            const inline = width / n
            const ls = Array.from({ length: n }, (_, i) => `l${inline} ${i % 2 ? block : -block}`).join('')
            el.setAttribute('d', `M${left} ${bottom}${ls}`)
            g.append(el)
          }
          return g
        }
      default:
        return (rects: DOMRectList, { color = 'yellow' }: { color?: string } = {}) => {
          const g = createSVG('g')
          g.setAttribute('fill', color)
          ;(g as SVGElement).style.opacity = '0.3'
          ;(g as SVGElement).style.mixBlendMode = 'multiply'
          for (const { left, top, height, width } of Array.from(rects)) {
            const el = createSVG('rect')
            el.setAttribute('x', String(left))
            el.setAttribute('y', String(top))
            el.setAttribute('height', String(height))
            el.setAttribute('width', String(width))
            g.append(el)
          }
          return g
        }
    }
  }

  function requestDraw(view: unknown, cfi: string) {
    const entry = annotationStyleMap.get(cfi)
    const failed = () => {
      if (entry && annotationStyleMap.get(cfi) === entry) pending.value.add(cfi)
    }
    try {
      const renderer = view as { addAnnotation?: (annotation: { value: string }) => unknown } | null
      void Promise.resolve(renderer?.addAnnotation?.({ value: cfi })).catch(failed)
    } catch {
      failed()
    }
  }

  function addAnnotation(view: unknown, cfi: string, color = '#FACC15', style = 'highlight', text?: string) {
    annotationStyleMap.set(cfi, { color, style, ...(text !== undefined && { text }) })
    requestDraw(view, cfi)
  }

  function addAnnotations(view: unknown, anns: { cfi: string; color: string; style: string; text?: string }[]) {
    for (const ann of anns) {
      annotationStyleMap.set(ann.cfi, { color: ann.color, style: ann.style, ...(ann.text !== undefined && { text: ann.text }) })
      requestDraw(view, ann.cfi)
    }
  }

  function deleteAnnotation(view: unknown, cfi: string) {
    annotationStyleMap.delete(cfi)
    pending.value.delete(cfi)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(view as any)?.deleteAnnotation?.({ value: cfi })
  }

  function redrawAnnotation(view: unknown, cfi: string, color: string, style: string) {
    annotationStyleMap.set(cfi, { ...annotationStyleMap.get(cfi), color, style })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(view as any)?.deleteAnnotation?.({ value: cfi })
    requestDraw(view, cfi)
  }

  function reAddAll(view: unknown) {
    setTimeout(() => {
      for (const [cfi] of annotationStyleMap) {
        requestDraw(view, cfi)
      }
    }, 100)
  }

  function handleDrawAnnotationEvent(e: CustomEvent) {
    const { draw, annotation, range } = e.detail ?? {}
    if (!draw || !annotation?.value) return
    const stored = annotationStyleMap.get(annotation.value)
    if (!stored) return
    if (stored.text !== undefined && !verifiesAnnotationRange(range, stored.text)) {
      pending.value.add(annotation.value)
      return
    }
    pending.value.delete(annotation.value)
    draw(getDrawFunction(stored.style), { color: stored.color })
  }

  return {
    annotationStyleMap,
    pendingAnnotationCount: computed(() => pending.value.size),
    getDrawFunction,
    addAnnotation,
    addAnnotations,
    deleteAnnotation,
    redrawAnnotation,
    reAddAll,
    handleDrawAnnotationEvent,
  }
}

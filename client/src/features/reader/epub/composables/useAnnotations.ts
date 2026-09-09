import { ref } from 'vue'
import type { AnnotationItem, EpubAnnotationInput } from '@bookorbit/types'
import type { AnnotationProjection } from './reader-annotation-projection'
import { api } from '@/lib/api'

export type Annotation = AnnotationItem

export interface AnnotationPatch {
  note?: string | null
  color?: string
  style?: string
}

export function useAnnotations() {
  const annotations = ref<Annotation[]>([])
  const projections = new Map<number, AnnotationProjection>()
  const originalTargets = new Map<string, number>()
  const loadError = ref<string | null>(null)

  function drawableForFile(fileId: number) {
    return annotations.value.filter(
      (annotation): annotation is Annotation & { cfi: string } =>
        annotation.cfi != null &&
        (annotation.jumpFileId == null || annotation.jumpFileId === fileId) &&
        annotation.positionStatus !== 'pending' &&
        annotation.positionStatus !== 'failed',
    )
  }

  function hasUnverifiedForFile(fileId: number) {
    return annotations.value.some(
      (annotation) =>
        (annotation.jumpFileId == null || annotation.jumpFileId === fileId) &&
        (annotation.positionStatus === 'pending' || annotation.positionStatus === 'failed'),
    )
  }

  async function projectForFile(fileId: number, resolve: (annotation: Annotation, budgetMs: number) => Promise<AnnotationProjection>) {
    const deadline = performance.now() + 500
    let attempts = 0
    for (const annotation of annotations.value) {
      if (!annotation.sourceAnchor || (annotation.jumpFileId != null && annotation.jumpFileId !== fileId)) continue
      if (annotation.cfi) originalTargets.set(annotation.cfi, annotation.id)
      const result =
        ++attempts <= 100 && performance.now() < deadline
          ? await resolve(annotation, Math.min(100, deadline - performance.now())).catch(() => ({ cfi: null, positionStatus: 'pending' as const }))
          : { cfi: null, positionStatus: 'pending' as const }
      projections.set(annotation.id, result)
    }
    annotations.value = annotations.value.map((annotation) => ({ ...annotation, ...projections.get(annotation.id) }))
  }

  function projectedTarget(cfi: string): string | null {
    const id = originalTargets.get(cfi)
    return id === undefined ? cfi : (projections.get(id)?.cfi ?? null)
  }

  async function load(bookId: number) {
    loadError.value = null
    const res = await api(`/api/v1/books/${bookId}/annotations`)
    if (!res.ok) {
      loadError.value = 'Failed to load'
      return
    }
    projections.clear()
    originalTargets.clear()
    annotations.value = await res.json()
  }

  async function create(bookId: number, data: EpubAnnotationInput): Promise<Annotation | null> {
    const res = await api(`/api/v1/books/${bookId}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) return null
    const created: Annotation = await res.json()
    annotations.value = [...annotations.value, created]
    return created
  }

  async function update(bookId: number, id: number, data: AnnotationPatch): Promise<Annotation | null> {
    const res = await api(`/api/v1/books/${bookId}/annotations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) return null

    const response: Annotation = await res.json()
    const updated = { ...response, ...projections.get(id) }
    annotations.value = annotations.value.map((a) => (a.id === id ? updated : a))
    return updated
  }

  function updateNote(bookId: number, id: number, note: string | null): Promise<Annotation | null> {
    return update(bookId, id, { note })
  }

  async function remove(bookId: number, id: number) {
    const res = await api(`/api/v1/books/${bookId}/annotations/${id}`, {
      method: 'DELETE',
    })
    if (res.ok) {
      annotations.value = annotations.value.filter((a) => a.id !== id)
    }
  }

  return { annotations, loadError, projectForFile, projectedTarget, drawableForFile, hasUnverifiedForFile, load, create, update, updateNote, remove }
}

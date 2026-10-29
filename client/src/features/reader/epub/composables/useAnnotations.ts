import { ref } from 'vue'
import type { AnnotationItem, AnnotationListResponse, EpubAnnotationInput } from '@bookorbit/types'
import type { AnnotationProjection } from './reader-annotation-projection'
import { api } from '@/lib/api'

export type Annotation = AnnotationItem

export interface AnnotationPatch {
  note?: string | null
  color?: string
  style?: string
}

async function send(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await (init ? api(path, init) : api(path))
  } catch {
    return null
  }
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

  async function load(bookId: number, readerFileId?: number) {
    loadError.value = null
    if (readerFileId != null) {
      const loaded: Annotation[] = []
      for (let page = 1; ; page += 1) {
        const res = await send(`/api/v1/books/${bookId}/annotations?page=${page}&pageSize=100&readerFileId=${readerFileId}`)
        if (!res?.ok) {
          loadError.value = 'Failed to load'
          return
        }
        const result: AnnotationListResponse = await res.json()
        loaded.push(...result.items)
        if (loaded.length >= result.total || result.items.length === 0) break
      }
      annotations.value = loaded
      return
    }
    const res = await send(`/api/v1/books/${bookId}/annotations`)
    if (!res?.ok) {
      loadError.value = 'Failed to load'
      return
    }
    projections.clear()
    originalTargets.clear()
    annotations.value = await res.json()
  }

  async function create(bookId: number, data: EpubAnnotationInput): Promise<Annotation | null> {
    const res = await send(`/api/v1/books/${bookId}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res?.ok) return null
    const created: Annotation = await res.json()
    annotations.value = [...annotations.value, created]
    return created
  }

  async function update(bookId: number, id: number, data: AnnotationPatch): Promise<Annotation | null> {
    const res = await send(`/api/v1/books/${bookId}/annotations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res?.ok) return null

    const canonical: Annotation = await res.json()
    const existing = annotations.value.find((annotation) => annotation.id === id)
    const updated: Annotation = existing
      ? {
          ...canonical,
          cfi: existing.cfi,
          jumpFileId: existing.jumpFileId,
          positionStatus: existing.positionStatus,
          chapterIndex: existing.chapterIndex,
        }
      : canonical
    Object.assign(updated, projections.get(id))
    annotations.value = annotations.value.map((a) => (a.id === id ? updated : a))
    return updated
  }

  function updateNote(bookId: number, id: number, note: string | null): Promise<Annotation | null> {
    return update(bookId, id, { note })
  }

  async function remove(bookId: number, id: number): Promise<boolean> {
    const res = await send(`/api/v1/books/${bookId}/annotations/${id}`, {
      method: 'DELETE',
    })
    if (!res?.ok) return false
    annotations.value = annotations.value.filter((a) => a.id !== id)
    return true
  }

  return { annotations, loadError, projectForFile, projectedTarget, drawableForFile, hasUnverifiedForFile, load, create, update, updateNote, remove }
}

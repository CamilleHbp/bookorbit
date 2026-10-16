import { computed, ref } from 'vue'
import type { ServerFontFamilyUsage, ServerFontUsageResponse, UserFont } from '@bookorbit/types'
import { FONT_FORMAT_EXTENSIONS, MAX_FONT_FILE_SIZE } from '@bookorbit/types'
import { api } from '@/lib/api'
import { useCustomFonts, type FontUpdate } from '@/features/reader/epub/composables/useCustomFonts'
import { familyVariants } from '@/features/reader/shared/lib/font-variants'
import { outcomeOfError, type UploadFace, type UploadState } from '../lib/upload-outcome'
import type { FontUploadErrorCode } from '@bookorbit/types'

const ENDPOINT = '/api/v1/server-fonts'
const ACCEPTED = Object.values(FONT_FORMAT_EXTENSIONS)

export interface UploadEntry {
  id: number
  fileName: string
  size: number
  state: UploadState
  face: UploadFace | null
  /** The style's own name in the font ("Italic", "SemiBold"), when the font names it. */
  styleName: string | null
  /** The file started a family the server did not have. */
  newFamily: boolean
  code: FontUploadErrorCode | null
  meta: Record<string, string | number>
}

export type RenameResult = { ok: true } | { ok: false; code: string | null }

const NO_USAGE = (familyName: string): ServerFontFamilyUsage => ({ familyName, books: 0, readers: 0, defaults: 0, hidden: 0 })

/**
 * The server collection as the Server Fonts page manages it: the files, how readers use each
 * family, and a queue that uploads dropped files one at a time and remembers how each one ended.
 */
export function useServerFontLibrary() {
  const customFonts = useCustomFonts()
  const store = customFonts.scopeStore('server')

  const usage = ref(new Map<string, ServerFontFamilyUsage>())
  const uploads = ref<UploadEntry[]>([])
  /** Families this visit's uploads created, marked until the tray is dismissed. */
  const newFamilies = ref(new Set<string>())
  let nextUploadId = 1

  const uploading = computed(() => uploads.value.some((entry) => entry.state === 'queued' || entry.state === 'uploading'))

  async function fetchUsage(): Promise<void> {
    try {
      const res = await api(`${ENDPOINT}/usage`)
      if (!res.ok) return
      const body: ServerFontUsageResponse = await res.json()
      usage.value = new Map(body.families.map((family) => [family.familyName, family]))
    } catch {
      // Usage is context for the decision, not the decision; the page works without it.
    }
  }

  async function load(): Promise<void> {
    await Promise.all([store.fetchFonts(), fetchUsage()])
  }

  function usageOf(familyName: string): ServerFontFamilyUsage {
    return usage.value.get(familyName) ?? NO_USAGE(familyName)
  }

  /** The name the reader's Style row will show for this face, taken from the family on the server. */
  function styleNameOf(face: UploadFace | null): string | null {
    if (!face) return null
    const variants = familyVariants(store.fonts.value.filter((font) => font.familyName === face.familyName))
    return variants.find((variant) => variant.weight === face.weight && variant.style === face.style)?.name ?? null
  }

  function patchEntry(id: number, patch: Partial<UploadEntry>) {
    uploads.value = uploads.value.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))
  }

  /** Answers the checks a browser can make without sending the bytes: the extension and the size. */
  function precheck(file: File): FontUploadErrorCode | null {
    const lower = file.name.toLowerCase()
    if (!ACCEPTED.some((extension) => lower.endsWith(extension))) return 'FONT_UNSUPPORTED_TYPE'
    if (file.size > MAX_FONT_FILE_SIZE) return 'FONT_TOO_LARGE'
    return null
  }

  async function addFiles(files: File[]): Promise<void> {
    if (files.length === 0) return
    const queued = files.map((file) => ({
      file,
      entry: {
        id: nextUploadId++,
        fileName: file.name,
        size: file.size,
        state: 'queued' as UploadState,
        face: null,
        styleName: null,
        newFamily: false,
        code: null,
        meta: {},
      },
    }))
    uploads.value = [...uploads.value, ...queued.map(({ entry }) => entry)]

    // One at a time: a font can be 50 MB and the queue can be a whole family's worth of files.
    for (const { file, entry } of queued) {
      const refused = precheck(file)
      if (refused) {
        patchEntry(entry.id, {
          state: 'refused',
          code: refused,
          meta: refused === 'FONT_TOO_LARGE' ? { maxMb: MAX_FONT_FILE_SIZE / 1024 / 1024 } : {},
        })
        continue
      }
      patchEntry(entry.id, { state: 'uploading' })
      const known = new Set(store.fonts.value.map((font) => font.familyName))
      try {
        const result = await store.uploadFont(file)
        if (!result) throw new Error('Upload failed')
        const { familyName, weight, style } = result.font
        const newFamily = !known.has(familyName)
        if (newFamily) newFamilies.value = new Set([...newFamilies.value, familyName])
        const face = { familyName, weight, style }
        patchEntry(entry.id, { state: 'added', face, styleName: styleNameOf(face), newFamily })
      } catch (err) {
        const outcome = outcomeOfError(err)
        patchEntry(entry.id, {
          state: outcome.state,
          face: outcome.face,
          styleName: styleNameOf(outcome.face),
          code: outcome.code,
          meta: outcome.meta,
        })
      }
    }
    await fetchUsage()
  }

  function dismissUploads() {
    if (uploading.value) return
    uploads.value = []
    newFamilies.value = new Set()
  }

  async function renameFamily(familyName: string, newFamilyName: string): Promise<RenameResult> {
    try {
      const res = await api(`${ENDPOINT}/families`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ familyName, newFamilyName }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        return { ok: false, code: typeof body.errorCode === 'string' ? body.errorCode : null }
      }
      const renamed: UserFont[] = await res.json()
      const byId = new Map(renamed.map((font) => [font.id, font]))
      store.setFonts(store.fonts.value.map((font) => byId.get(font.id) ?? font))
      if (newFamilies.value.has(familyName))
        newFamilies.value = new Set([...newFamilies.value].map((name) => (name === familyName ? newFamilyName : name)))
      await fetchUsage()
      return { ok: true }
    } catch {
      return { ok: false, code: null }
    }
  }

  /**
   * Removes a family file by file. A file that fails stays listed, so a partial removal shows as a
   * smaller family rather than as a family that looks gone but still sits in readers' pickers.
   */
  async function removeFamily(familyName: string): Promise<{ removed: number; failed: number }> {
    const files = store.fonts.value.filter((font) => font.familyName === familyName)
    let removed = 0
    for (const font of files) {
      const ok = await store.deleteFont(font.id).catch(() => false)
      if (ok) removed++
    }
    await fetchUsage()
    return { removed, failed: files.length - removed }
  }

  async function updateFile(fontId: number, data: FontUpdate): Promise<boolean> {
    return (await store.updateFont(fontId, data)) !== null
  }

  return {
    store,
    usage,
    uploads,
    uploading,
    newFamilies,
    load,
    fetchUsage,
    usageOf,
    addFiles,
    dismissUploads,
    renameFamily,
    removeFamily,
    updateFile,
  }
}

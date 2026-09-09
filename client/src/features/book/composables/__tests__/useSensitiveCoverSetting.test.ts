import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import type { BookDetail } from '@bookorbit/types'
import { api } from '@/lib/api'
import { toast } from 'vue-sonner'
import { useSensitiveCoverSetting } from '../useSensitiveCoverSetting'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn<(message: string) => void>() } }))
const bumpVersion = vi.hoisted(() => vi.fn<(bookId: number) => void>())
vi.mock('../useCoverVersions', () => ({ useCoverVersions: () => ({ bumpVersion }) }))

function setup() {
  const scope = effectScope()
  const book = ref({ id: 7, sensitiveCover: false } as BookDetail)
  const state = scope.run(() => useSensitiveCoverSetting(book))!
  return { scope, book, ...state }
}
afterEach(() => vi.clearAllMocks())

describe('sensitive cover setting', () => {
  it('saves a typed flag and invalidates covers after success', async () => {
    vi.mocked(api).mockResolvedValue(new Response(null, { status: 204 }))
    const state = setup()
    expect(await state.saveSensitiveCover(true)).toBe(true)
    expect(api).toHaveBeenCalledWith('/api/v1/books/7/sensitive-cover', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sensitiveCover: true }),
    })
    expect(state.sensitiveCover.value).toBe(true)
    expect(bumpVersion).toHaveBeenCalledWith(7)
    expect(state.savingSensitiveCover.value).toBe(false)
    state.scope.stop()
  })
  it('keeps the previous flag on failure and allows a retry', async () => {
    vi.mocked(api).mockResolvedValue(new Response(null, { status: 403 }))
    const state = setup()
    expect(await state.saveSensitiveCover(true)).toBe(false)
    expect(state.sensitiveCover.value).toBe(false)
    expect(state.savingSensitiveCover.value).toBe(false)
    expect(bumpVersion).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('book.sensitiveCover.saveError')
    state.scope.stop()
  })
  it('does not apply a late save to a different book or send duplicate requests', async () => {
    let resolve!: (response: Response) => void
    vi.mocked(api).mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done
      }),
    )
    const state = setup()
    const pending = state.saveSensitiveCover(true)
    expect(state.savingSensitiveCover.value).toBe(true)
    expect(await state.saveSensitiveCover(true)).toBe(false)
    state.book.value = { id: 8, sensitiveCover: false } as BookDetail
    await nextTick()
    resolve(new Response(null, { status: 204 }))
    expect(await pending).toBe(false)
    expect(state.sensitiveCover.value).toBe(false)
    expect(api).toHaveBeenCalledTimes(1)
    expect(bumpVersion).toHaveBeenCalledWith(7)
    state.scope.stop()
  })
})

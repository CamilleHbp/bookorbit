import { describe, expect, it, vi, beforeEach } from 'vitest'
import { api } from '@/lib/api'
import { useFanfictionPreferences } from './useFanfictionPreferences'
vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))

describe('story update defaults', () => {
  beforeEach(() => vi.resetAllMocks())
  it('loads the account default and saves without changing adult confirmation', async () => {
    vi.mocked(api).mockResolvedValue(new Response(JSON.stringify({ isAdult: true, defaultUpdatePolicy: 'review' })))
    const model = useFanfictionPreferences()
    await model.load()
    expect(model.defaultUpdatePolicy.value).toBe('review')
    model.defaultUpdatePolicy.value = 'safe'
    vi.mocked(api).mockResolvedValue(new Response(JSON.stringify({ isAdult: true, defaultUpdatePolicy: 'safe' })))
    expect(await model.save()).toBe(true)
    expect(JSON.parse(vi.mocked(api).mock.calls[1]![1]!.body as string)).toEqual({ defaultUpdatePolicy: 'safe' })
    expect(model.isAdult.value).toBe(true)
  })
  it('confirms adulthood without overwriting the update policy', async () => {
    vi.mocked(api).mockResolvedValue(new Response(JSON.stringify({ isAdult: true, defaultUpdatePolicy: 'review' })))
    const model = useFanfictionPreferences()
    await model.allowAdult()
    expect(JSON.parse(vi.mocked(api).mock.calls[0]![1]!.body as string)).toEqual({ isAdult: true })
    expect(model.defaultUpdatePolicy.value).toBe('review')
  })
})

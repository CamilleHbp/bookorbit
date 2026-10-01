import { effectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useDiscoveryReview } from './useDiscoveryReview'
import { useWebsiteReview } from './useWebsiteReview'
import { discoveryReviewFixture } from './discoveryReviewFixture'
vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
describe('stable website review', () => {
  let scope: ReturnType<typeof effectScope>
  let fixture: ReturnType<typeof discoveryReviewFixture>
  beforeEach(() => {
    vi.useFakeTimers()
    scope = effectScope()
    fixture = discoveryReviewFixture()
    vi.mocked(api).mockImplementation(fixture.fetch)
  })
  afterEach(() => {
    scope.stop()
    vi.useRealTimers()
    vi.clearAllMocks()
  })
  async function setup() {
    const review = scope.run(() => useDiscoveryReview(1))!
    await review.recover()
    const source = scope.run(() =>
      useWebsiteReview(
        () => review.websites.value.find((item) => item.website === 'royalroad.com')!,
        () => review.cutoff.value,
        review,
      ),
    )!
    return { review, source }
  }
  it('loads only the opened website and preselects matching remote titles and authors', async () => {
    const { source } = await setup()
    expect(fixture.calls.some((call) => call.path.includes('/discovery?'))).toBe(false)
    await source.toggleOpen()
    await flushPromises()
    expect(source.items.value).toHaveLength(20)
    expect(source.total.value).toBe(23)
    expect(source.selectedCount.value).toBe(19)
    expect(source.isSelected(source.items.value[1]!)).toBe(false)
    expect(source.comparisons.value['2']?.remote?.title).toBe('A different title')
    const count = fixture.calls.length
    await source.toggleOpen()
    await source.toggleOpen()
    await flushPromises()
    expect(fixture.calls).toHaveLength(count)
  })
  it('selects the whole website across pages and keeps results in place after linking', async () => {
    const { source } = await setup()
    await source.toggleOpen()
    await flushPromises()
    source.toggleAll()
    source.toggleBook(source.items.value[0]!)
    expect(source.selectedCount.value).toBe(22)
    await source.nextPage()
    await flushPromises()
    expect(source.items.value.map((book) => book.id)).toEqual(['21', '22', '23'])
    expect(source.selectedCount.value).toBe(22)
    await source.previousPage()
    await flushPromises()
    expect(source.isSelected(source.items.value[0]!)).toBe(false)
    const visible = source.items.value.map((book) => book.id)
    await source.link()
    expect(fixture.calls.find((call) => call.path.endsWith('/selection'))!.body).toMatchObject({
      website: 'royalroad.com',
      allMatching: true,
      excludedIds: ['1'],
      review: true,
      cutoff: '2026-09-10T12:00:00.000Z',
    })
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()
    expect(source.items.value.map((book) => book.id)).toEqual(visible)
    expect(source.items.value[1]!.state).toBe('linked')
    expect(source.finished.value).toBe(true)
    expect(source.total.value).toBe(1)
    expect(source.selectedCount.value).toBe(0)
    expect(fixture.books.slice(23).every((book) => book.state === 'pending')).toBe(true)
    expect(fixture.calls.filter((call) => call.path.includes('/discovery?')).at(-1)!.path).toContain('ids=')
    await source.remaining()
    await flushPromises()
    expect(source.items.value.map((book) => book.id)).toEqual(['1'])
  })
  it('retains manual deselection and comparison counts across pages', async () => {
    const { source } = await setup()
    await source.toggleOpen()
    await flushPromises()
    source.toggleBook(source.items.value[0]!)
    await source.nextPage()
    await flushPromises()
    expect(source.selectedCount.value).toBe(21)
    expect(source.uncheckedCount.value).toBe(0)
    await source.previousPage()
    await flushPromises()
    expect(source.isSelected(source.items.value[0]!)).toBe(false)
  })
  it('ignores stale comparisons after changing the website profile and bounds concurrent requests', async () => {
    const { source } = await setup()
    const waiting: (() => void)[] = []
    let active = 0
    let peak = 0
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (String(path).endsWith('/compare')) {
        active++
        peak = Math.max(peak, active)
        await new Promise<void>((resolve) => waiting.push(resolve))
        active--
      }
      return fixture.fetch(path, options)
    })
    await source.toggleOpen()
    await flushPromises()
    expect(active).toBe(2)
    source.profile.value = 'public'
    await source.changeProfile()
    await source.toggleOpen()
    while (waiting.length) {
      waiting.shift()!()
      await flushPromises()
    }
    expect(peak).toBe(2)
    expect(source.selectedCount.value).toBe(0)
    expect(Object.values(source.comparisons.value).some((comparison) => comparison.remote)).toBe(false)
  })
  it('retries an uncertain submission with the identical source snapshot', async () => {
    const { source, review } = await setup()
    await source.toggleOpen()
    await flushPromises()
    source.toggleAll()
    fixture.setUncertain(true)
    await source.link()
    expect(review.locked.value).toBe(true)
    const first = fixture.calls.filter((call) => call.path.endsWith('/selection'))[0]!
    fixture.setUncertain(false)
    await review.submitPending()
    expect(fixture.calls.filter((call) => call.path.endsWith('/selection'))[1]).toEqual(first)
  })
})

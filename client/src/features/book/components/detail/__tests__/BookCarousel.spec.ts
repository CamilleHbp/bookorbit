import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import BookCarousel, { type CarouselBook } from '../BookCarousel.vue'
import { useDisplaySettings } from '@/composables/useDisplaySettings'
import type { ReadStatus } from '@bookorbit/types'

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return { ...actual, useRouter: () => ({ push: vi.fn<(...args: unknown[]) => unknown>() }) }
})
vi.mock('@/features/book/composables/useCoverVersions', () => ({
  useCoverVersions: () => ({ coverUrl: () => '/cover.jpg' }),
}))

function makeBook(id: number, status: ReadStatus | null): CarouselBook {
  return {
    id,
    title: `Book ${id}`,
    coverAspectRatio: '2/3',
    updatedAt: null,
    hasCover: true,
    authors: [],
    readStatus: status ? { status, source: 'manual', startedAt: null, finishedAt: null, updatedAt: '2026-01-01T00:00:00.000Z' } : null,
  }
}

function mountCarousel(books: CarouselBook[]) {
  return mount(BookCarousel, { props: { books, loading: false, showHeader: false } })
}

describe('BookCarousel read status badge', () => {
  it('keeps temporary reveal separate from book navigation', async () => {
    const { hideSensitiveCovers } = useDisplaySettings()
    hideSensitiveCovers.value = true
    try {
      const wrapper = mountCarousel([{ ...makeBook(1, null), sensitiveCover: true }])
      const card = wrapper.get('[data-book-id="1"]')
      expect(card.findAll('button')).toHaveLength(2)
      expect(card.find('button button').exists()).toBe(false)
      await card.get('button[aria-pressed]').trigger('click')
      expect(card.get('button[aria-pressed]').attributes('aria-pressed')).toBe('true')
      expect(hideSensitiveCovers.value).toBe(true)
    } finally {
      hideSensitiveCovers.value = false
    }
  })

  it('labels a card with the read status of its book', () => {
    const wrapper = mountCarousel([makeBook(1, 'reading')])

    expect(wrapper.get('[data-book-id="1"]').text()).toContain('Reading')
  })

  it('draws no badge for an unread or untracked book', () => {
    const wrapper = mountCarousel([makeBook(1, 'unread'), makeBook(2, null)])

    expect(wrapper.get('[data-book-id="1"]').find('.sr-only').exists()).toBe(false)
    expect(wrapper.get('[data-book-id="2"]').find('.sr-only').exists()).toBe(false)
  })

  it('badges only the books that carry a status', () => {
    const wrapper = mountCarousel([makeBook(1, 'read'), makeBook(2, null), makeBook(3, 'abandoned')])

    expect(wrapper.get('[data-book-id="1"]').text()).toContain('Read')
    expect(wrapper.get('[data-book-id="2"]').find('.sr-only').exists()).toBe(false)
    expect(wrapper.get('[data-book-id="3"]').text()).toContain('Abandoned')
  })
})

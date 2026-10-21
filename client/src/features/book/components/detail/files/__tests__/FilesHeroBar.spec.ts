import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { BookDetail } from '@bookorbit/types'
import { activateI18nLocale, i18n } from '@/i18n'

import FilesHeroBar from '../FilesHeroBar.vue'

const t = i18n.global.t
let wrapper: VueWrapper | null = null

const BOOK = { id: 12, title: 'Dune', coverSource: null, coverVersion: null, status: 'present', files: [] } as unknown as BookDetail

beforeAll(() => {
  activateI18nLocale('en')
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

function mountBar(props: { readAloudNote: string | null; readAloudRetryable?: boolean; readAloudChecking?: boolean }) {
  wrapper = mount(FilesHeroBar, {
    attachTo: document.body,
    props: {
      book: BOOK,
      fileCount: 2,
      totalBytes: 2048,
      runtimeLabel: null,
      formatShares: [],
      folderSegments: ['Dune'],
      canUpload: false,
      showReadAloud: true,
      readAloudAvailable: false,
      sortKey: 'name',
      sortDirection: 'asc',
      sortOptions: [],
      ...props,
    },
  })
  return wrapper
}

const checkAgainButton = (bar: VueWrapper) => bar.get('[data-test="read-aloud-check-again"]')

describe('FilesHeroBar read-aloud note', () => {
  it('exposes a failed availability check as a status the Create button is described by', () => {
    const bar = mountBar({ readAloudNote: t('book.detail.files.readAloud.loadFailed'), readAloudRetryable: true })

    const note = bar.get('[data-test="read-aloud-note"]')
    expect(note.attributes('role')).toBe('status')
    expect(note.text()).toBe(t('book.detail.files.readAloud.loadFailed'))
    const create = bar.findAll('button').find((button) => button.text().includes(t('book.detail.files.readAloud.action')))!
    expect(create.attributes('aria-describedby')).toBe(note.attributes('id'))
  })

  it('shows the recheck as busy, keeps the button focusable, and ignores clicks until it finishes', async () => {
    const bar = mountBar({ readAloudNote: t('book.detail.files.readAloud.loadFailed'), readAloudRetryable: true })
    const button = checkAgainButton(bar)
    expect(button.text()).toBe(t('book.detail.files.readAloud.checkAgain'))
    expect(button.attributes('aria-busy')).toBeUndefined()

    ;(button.element as HTMLButtonElement).focus()
    await button.trigger('click')
    expect(bar.emitted('retryReadAloud')).toHaveLength(1)

    await bar.setProps({ readAloudChecking: true })
    expect(button.text()).toBe(t('book.detail.files.readAloud.checking'))
    expect(button.attributes('aria-busy')).toBe('true')
    expect(button.attributes('aria-disabled')).toBe('true')
    expect(button.attributes('disabled')).toBeUndefined()
    expect(document.activeElement).toBe(button.element)

    await button.trigger('click')
    expect(bar.emitted('retryReadAloud')).toHaveLength(1)
  })

  it('updates the same status region when the recheck fails again, so the failure is announced', async () => {
    const bar = mountBar({ readAloudNote: t('book.detail.files.readAloud.loadFailed'), readAloudRetryable: true, readAloudChecking: true })
    const note = bar.get('[data-test="read-aloud-note"]')

    await bar.setProps({ readAloudChecking: false, readAloudNote: t('book.detail.files.readAloud.loadFailedAgain', { count: 1 }) })

    expect(bar.get('[data-test="read-aloud-note"]').element).toBe(note.element)
    expect(note.text()).toBe(t('book.detail.files.readAloud.loadFailedAgain', { count: 1 }))
    expect(note.text()).not.toBe(t('book.detail.files.readAloud.loadFailed'))
    expect(checkAgainButton(bar).text()).toBe(t('book.detail.files.readAloud.checkAgain'))
  })

  it('offers no recheck for a reason that checking again cannot change', () => {
    const bar = mountBar({ readAloudNote: t('book.detail.files.readAloud.reasons.worker_unavailable') })

    expect(bar.get('[data-test="read-aloud-note"]').attributes('role')).toBe('status')
    expect(bar.find('[data-test="read-aloud-check-again"]').exists()).toBe(false)
  })
})

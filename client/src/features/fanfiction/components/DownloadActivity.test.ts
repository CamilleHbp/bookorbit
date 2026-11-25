import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FanfictionDownloadQueue, FanfictionDownloadRow } from '@bookorbit/types'
import { setI18nLocale } from '@/i18n'
import DownloadActivity from './DownloadActivity.vue'
import DownloadRow from './DownloadRow.vue'

const base = { id: 'story', section: 'running', site: 'example.org', title: 'A long story', jobId: 'job', groupKey: null } as FanfictionDownloadRow
const snapshot = {
  items: [],
  recent: [],
  totals: { running: 1, queued: 2, retrying: 1, attention: 2 },
  storyCounts: { running: 1, queued: 8, retrying: 4, attention: 27 },
} as FanfictionDownloadQueue

afterEach(() => {
  vi.useRealTimers()
})
describe('reader-facing live download activity', () => {
  it('counts stories rather than issue groups and keeps connection failures honest', async () => {
    const wrapper = mount(DownloadActivity, { props: { snapshot, checkedAt: new Date() } })
    expect(wrapper.text()).toContain('8 waiting')
    const retry = wrapper.findAll('button').find((button) => button.text() === 'Retrying automatically (4)')!
    await retry.trigger('click')
    expect(wrapper.emitted('jump')).toEqual([['retrying']])
    expect(wrapper.text()).toContain('Needs attention: 27')
    expect(wrapper.text()).toContain('Auto-updating')
    await wrapper.setProps({ error: true })
    expect(wrapper.text()).toContain('Updates paused')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('refresh')).toHaveLength(1)
    wrapper.unmount()
  })
  it('keeps idle counts visible without offering empty destinations', () => {
    const totals = { running: 0, queued: 0, retrying: 0, attention: 0 }
    const wrapper = mount(DownloadActivity, { props: { snapshot: { ...snapshot, totals, storyCounts: totals } } })
    expect(wrapper.text()).toContain('0 in progress')
    expect(wrapper.text()).toContain('0 waiting')
    expect(wrapper.findAll('button')).toHaveLength(1)
    wrapper.unmount()
  })
  it('shows the current chapter, illustration and last activity without exposing internal codes', () => {
    const now = new Date('2026-11-16T10:00:00Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const wrapper = mount(DownloadRow, {
      props: {
        libraryId: 1,
        row: {
          ...base,
          lastContactAt: now.toISOString(),
          progress: {
            stage: 'downloading',
            completedChapters: 12,
            totalChapters: 241,
            currentChapter: 13,
            currentChapterTitle: 'A difficult crossing',
            activity: 'illustrations',
            illustration: 7,
            updatedAt: new Date(now.getTime() - 120000).toISOString(),
          },
        },
      },
    })
    expect(wrapper.text()).toContain('Chapter 13 of 241: A difficult crossing')
    expect(wrapper.text()).toContain('Preparing illustration 7.')
    expect(wrapper.text()).toContain('Updated 2 minutes ago')
    expect(wrapper.text()).toContain('Still working')
    expect(wrapper.get('progress').attributes('value')).toBe('5')
    wrapper.unmount()
  })
  it('explains a queued story and does not promise a past retry time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-16T10:00:00Z'))
    const wrapper = mount(DownloadRow, {
      props: { libraryId: 1, row: { ...base, section: 'queued', waitingFor: 'website_busy', nextAttemptAt: '2026-11-16T09:00:00Z' } },
    })
    expect(wrapper.text()).toContain('Waiting for another story from example.org to finish.')
    expect(wrapper.find('time').exists()).toBe(false)
    wrapper.unmount()
  })
  it('provides the new activity in French', async () => {
    await setI18nLocale('fr')
    try {
      const wrapper = mount(DownloadRow, {
        props: {
          libraryId: 1,
          row: { ...base, progress: { stage: 'downloading', completedChapters: 1, totalChapters: 5, activity: 'website', currentChapter: 2 } },
        },
      })
      expect(wrapper.text()).toContain('Chapitre 2 sur 5')
      expect(wrapper.text()).toContain('En attente de la réponse du site.')
      wrapper.unmount()
    } finally {
      await setI18nLocale('en')
    }
  })
})

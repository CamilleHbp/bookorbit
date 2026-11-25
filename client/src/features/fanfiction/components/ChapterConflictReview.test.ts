import { mount, flushPromises } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import type { FanfictionJob } from '@bookorbit/types'
import { api } from '@/lib/api'
import ChapterConflictReview from './ChapterConflictReview.vue'
import DownloadQueueControls from './DownloadQueueControls.vue'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
it('submits the displayed chapter decision with the selected scope', async () => {
  const chapter = {
    key: 'abc',
    title: 'One',
    savedLength: 50,
    websiteLength: 40,
    sourceUrl: 'https://example.org/one',
    savedExcerpt: 'Old passage',
    websiteExcerpt: 'New passage',
  }
  const job = { id: 'test', libraryId: 3, result: { contentReview: { chapters: [chapter] } } } as unknown as FanfictionJob
  vi.mocked(api).mockResolvedValue(Response.json(job))
  const view = mount(ChapterConflictReview, { props: { job } })
  expect(view.text()).toContain('Old passage')
  expect(view.get('a').attributes('href')).toBe(chapter.sourceUrl)
  await view.get('input').setValue(true)
  await view
    .findAll('button')
    .find((b) => b.text() === 'Keep saved chapter')!
    .trigger('click')
  await flushPromises()
  expect(JSON.parse(String(vi.mocked(api).mock.lastCall?.[1]?.body))).toEqual({
    action: 'apply',
    choice: 'saved',
    chapterKey: 'abc',
    remaining: true,
  })
  expect(view.emitted('resolved')).toHaveLength(1)
  view.unmount()
})
it('offers priority only while waiting and resume only while paused', async () => {
  vi.mocked(api).mockResolvedValue(Response.json({}))
  const view = mount(DownloadQueueControls, { props: { libraryId: 3, jobId: 'test', queued: true, paused: false } })
  await view
    .findAll('button')
    .find((b) => b.text() === 'Move to front')!
    .trigger('click')
  await flushPromises()
  expect(vi.mocked(api).mock.lastCall?.[0]).toBe('/api/v1/libraries/3/fanfiction/jobs/test/prioritize')
  await view.setProps({ paused: true })
  expect(view.findAll('button').map((b) => b.text())).toEqual(['Resume'])
  await view.get('button').trigger('click')
  await flushPromises()
  expect(vi.mocked(api).mock.lastCall?.[0]).toBe('/api/v1/libraries/3/fanfiction/jobs/test/resume')
  view.unmount()
})

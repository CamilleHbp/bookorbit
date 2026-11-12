import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import type { FanfictionJob, FanfictionSourceBatchStatus } from '@bookorbit/types'
import FanfictionLibraryStatus from './FanfictionLibraryStatus.vue'

const job = {
  id: 'check',
  kind: 'source_batch',
  state: 'review_required',
  createdAt: '2026-11-12T09:30:00Z',
  result: { selection: { action: 'update' } },
} as FanfictionJob
const summary = {
  job,
  checked: 120,
  total: 120,
  updated: 8,
  unchanged: 109,
  needsAttention: 3,
  trackingAvailable: true,
} as FanfictionSourceBatchStatus
const global = { stubs: { RouterLink: { template: '<a><slot /></a>' } } }

it('keeps failures visible in the last check even when there are no active downloads', () => {
  const wrapper = mount(FanfictionLibraryStatus, {
    props: { libraryId: 5, job, summary, totals: { running: 0, queued: 0, retrying: 0, attention: 0 } },
    global,
  })
  expect(wrapper.get('time').attributes('datetime')).toBe(job.createdAt)
  expect(wrapper.get('[role="status"]').text()).toBe('Needs attention')
  expect(wrapper.findAll('dd').map((item) => item.text())).toEqual(['8', '109', '3'])
  expect(wrapper.text()).toContain('120 of 120 checked')
})
it('does not claim a check happened when none is recorded or show stale success on a refresh error', () => {
  const wrapper = mount(FanfictionLibraryStatus, { props: { libraryId: 5, stale: true }, global })
  expect(wrapper.text()).toContain('No story check recorded.')
  expect(wrapper.get('[role="status"]').text()).toBe('Status unavailable')
  expect(wrapper.find('time').exists()).toBe(false)
})

it.each(['failed', 'configuration_blocked', 'review_required'])('keeps a %s check visible without tracked results', (state) => {
  const wrapper = mount(FanfictionLibraryStatus, {
    props: { libraryId: 5, job: { ...job, state } as FanfictionJob, totals: { running: 0, queued: 0, retrying: 0, attention: 0 } },
    global,
  })
  expect(wrapper.get('[role="status"]').text()).toBe('Needs attention')
})

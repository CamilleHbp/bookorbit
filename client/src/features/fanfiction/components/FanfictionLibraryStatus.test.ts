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
    props: { libraryId: 5, job, summary },
    global,
  })
  expect(wrapper.get('time').attributes('datetime')).toBe(job.createdAt)
  expect(wrapper.find('[role="status"]').exists()).toBe(false)
  expect(wrapper.findAll('dd').map((item) => item.text())).toEqual(['8', '109', '3'])
  expect(wrapper.text()).toContain('120 of 120 checked')
})
it('does not claim a check happened when none is recorded', () => {
  const wrapper = mount(FanfictionLibraryStatus, { props: { libraryId: 5 }, global })
  expect(wrapper.text()).toContain('No story check recorded.')
  expect(wrapper.find('time').exists()).toBe(false)
})

it('opens failed stories directly from the attention count and resets when the library changes', async () => {
  const wrapper = mount(FanfictionLibraryStatus, {
    attachTo: document.body,
    props: { libraryId: 5, job, summary },
    slots: { default: '<p>Failed story</p>' },
    global,
  })
  try {
    const count = wrapper.get('button[aria-expanded]')
    expect(count.attributes('aria-label')).toBe('Stories needing attention: 3')
    expect(count.attributes('aria-expanded')).toBe('false')
    expect(wrapper.text()).not.toContain('Failed story')
    expect(wrapper.text()).not.toContain('Check details')
    expect(wrapper.text()).not.toContain('Review issues')
    await count.trigger('click')
    expect(count.attributes('aria-expanded')).toBe('true')
    expect(wrapper.text()).toContain('Failed story')
    expect(document.activeElement?.id).toBe(count.attributes('aria-controls'))
    await wrapper.setProps({ libraryId: 6 })
    expect(wrapper.text()).not.toContain('Failed story')
  } finally {
    wrapper.unmount()
  }
})
it('keeps zero attention noninteractive and still exposes active controls and errors', async () => {
  const wrapper = mount(FanfictionLibraryStatus, {
    props: { libraryId: 5, job, summary: { ...summary, needsAttention: 0 } },
    slots: { default: '<p>Check actions</p>' },
    global,
  })
  expect(wrapper.find('button').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('Check actions')
  await wrapper.setProps({ checking: true })
  expect(wrapper.text()).toContain('Check actions')
  await wrapper.setProps({ checking: false, showActions: true })
  expect(wrapper.text()).toContain('Check actions')
  wrapper.unmount()
})

it.each(['failed', 'configuration_blocked', 'cancelled'])('exposes recovery for a tracked %s check with no failed child stories', (state) => {
  const wrapper = mount(FanfictionLibraryStatus, {
    props: { libraryId: 5, job: { ...job, state } as FanfictionJob, summary: { ...summary, needsAttention: 0 } },
    slots: { default: '<p>Last check recovery</p>' },
    global,
  })
  expect(wrapper.find('button').exists()).toBe(false)
  expect(wrapper.text()).toContain('Last check recovery')
  wrapper.unmount()
})

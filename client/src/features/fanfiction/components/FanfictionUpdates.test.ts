import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { FanfictionActivity, FanfictionJob } from '@bookorbit/types'
import FanfictionChangeLog from './FanfictionChangeLog.vue'
import FanfictionTaskCard from './FanfictionTaskCard.vue'
import FanfictionTaskList from './FanfictionTaskList.vue'

const global = { stubs: { RouterLink: { name: 'RouterLink', props: ['to'], template: '<a><slot /></a>' } } }
const job = (overrides: Partial<FanfictionJob>) =>
  ({
    id: 'job',
    libraryId: 5,
    kind: 'update',
    state: 'succeeded',
    url: 'https://www.royalroad.com/fiction/1',
    attempts: 1,
    cancellationRequested: false,
    result: null,
    errorCode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }) as FanfictionJob
const event = (overrides: Partial<FanfictionActivity>) =>
  ({
    id: 'event',
    libraryId: 5,
    sourceId: null,
    jobId: null,
    kind: 'updated',
    title: 'Paper Moons',
    bookId: 7,
    revisionId: null,
    errorCode: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  }) as FanfictionActivity
const logProps = { summary: null, kind: '' as const, page: 1, previous: false, next: false, busy: false }

afterEach(() => localStorage.clear())

describe('task cards', () => {
  it('names the story and offers a login fix instead of a retry for sign-in failures', async () => {
    const wrapper = mount(FanfictionTaskCard, {
      props: {
        job: job({ state: 'failed', errorCode: 'authentication_required', attempts: 3, sourceTitle: 'Paper Moons', result: { sourceId: 'source' } }),
        busy: false,
        bulkBusy: false,
        canManage: true,
      },
      global,
    })
    expect(wrapper.get('h3').text()).toBe('Paper Moons')
    expect(wrapper.text()).toContain('royalroad.com')
    const labels = wrapper.findAll('button').map((button) => button.text())
    expect(labels).toContain('Update website login')
    expect(labels).not.toContain('Retry')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Update website login')!
      .trigger('click')
    expect(wrapper.emitted('fixLogin')).toEqual([['source']])
  })

  it('shows running and failed tasks first and folds finished ones away', () => {
    const wrapper = mount(FanfictionTaskList, {
      props: {
        jobs: [job({ id: 'done' }), job({ id: 'running', state: 'running' }), job({ id: 'broken', state: 'failed' })],
        page: 1,
        previous: false,
        next: false,
        busy: false,
        bulkBusy: false,
        canManage: true,
        scoped: false,
      },
      global,
    })
    expect(wrapper.findAll('ul')[0]!.findAll('article')).toHaveLength(2)
    const finished = wrapper.get('details')
    expect(finished.attributes('open')).toBeUndefined()
    expect(finished.get('summary').text()).toBe('Show 1 finished task')
  })
})

describe('change log', () => {
  it('stays collapsed by default with the weekly summary visible, and remembers being opened', async () => {
    const summary = {
      since: new Date().toISOString(),
      counts: { imported: 1, updated: 9, rolled_back: 0, attention: 0, failed: 2, batch_completed: 0 },
      updatedStories: 4,
    }
    const wrapper = mount(FanfictionChangeLog, { props: { ...logProps, summary, items: [event({})] }, global })
    const details = wrapper.get('details')
    expect(details.attributes('open')).toBeUndefined()
    expect(wrapper.get('summary').text().replace(/\s+/g, ' ')).toContain('Last 7 days: 4 stories updated · 1 imported · 2 failed')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    expect(localStorage.getItem('bookorbit.fanfiction.changeLogOpen')).toBe('true')
    wrapper.unmount()
    expect(
      mount(FanfictionChangeLog, { props: { ...logProps, items: [] }, global })
        .get('details')
        .attributes('open'),
    ).toBeDefined()
  })

  it('groups rows by day, links titles, and filters by kind', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    const wrapper = mount(FanfictionChangeLog, {
      props: { ...logProps, items: [event({ id: 'a' }), event({ id: 'b', title: 'Blue Hour', kind: 'failed', createdAt: yesterday })] },
      global,
    })
    expect(wrapper.findAll('h3').map((heading) => heading.text())).toEqual(['Today', 'Yesterday'])
    expect(wrapper.findAll('a').map((link) => link.text())).toEqual(['Paper Moons', 'Blue Hour'])
    await wrapper.get('select').setValue('failed')
    expect(wrapper.emitted('filter')).toEqual([['failed']])
  })
})

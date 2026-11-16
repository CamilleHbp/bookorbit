import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { FanfictionJob } from '@bookorbit/types'
import FanfictionTaskCard from './FanfictionTaskCard.vue'

const job = {
  id: 'old-import',
  libraryId: 1,
  kind: 'import',
  state: 'configuration_blocked',
  url: 'https://example.org/story/1',
  errorCode: 'access_denied',
  attempts: 1,
  cancellationRequested: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  result: { progress: { stage: 'metadata' } },
} as FanfictionJob

describe('story task recovery actions', () => {
  let wrapper: ReturnType<typeof mount>
  afterEach(() => wrapper?.unmount())
  function open(value = job, canManage = true) {
    wrapper = mount(FanfictionTaskCard, {
      props: { job: value, busy: false, bulkBusy: false, canManage },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, StoryImportReview: true } },
    })
  }
  const retry = () => wrapper.findAll('button').find((button) => button.text() === 'Retry')
  it('allows a current retry alongside website settings after an old access failure', async () => {
    open()
    expect(wrapper.text()).toContain('Website logins')
    expect(retry()).toBeDefined()
    await retry()!.trigger('click')
    expect(wrapper.emitted('retry')).toEqual([[job]])
  })
  it('resumes an approved chapter review that failed after approval', () => {
    open({
      ...job,
      kind: 'update',
      state: 'failed',
      errorCode: 'source_failed',
      result: { contentReview: { approved: true, previousState: 'active' } },
    })
    expect(retry()).toBeDefined()
  })
  it('keeps unapproved chapter changes and unauthorized tasks out of Retry', async () => {
    open({ ...job, kind: 'update', state: 'review_required', result: { contentReview: { approved: false, previousState: 'active' } } })
    expect(retry()).toBeUndefined()
    await wrapper.setProps({ job, canManage: false })
    expect(retry()).toBeUndefined()
  })
})

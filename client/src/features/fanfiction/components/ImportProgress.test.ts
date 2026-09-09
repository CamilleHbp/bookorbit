import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { FanfictionJob } from '@bookorbit/types'
import ImportProgress from './ImportProgress.vue'

const job = (overrides: Partial<FanfictionJob> = {}): FanfictionJob => ({
  id: 'job',
  libraryId: 1,
  kind: 'import',
  state: 'running',
  url: 'https://fiction.live/story',
  attempts: 1,
  cancellationRequested: false,
  errorCode: null,
  createdAt: '',
  updatedAt: '',
  result: { progress: { stage: 'downloading', completedChapters: 12, totalChapters: 40 } },
  ...overrides,
})
describe('import progress', () => {
  it.each([
    ['download_limit', 'This story exceeds the download limit'],
    ['response_too_large', 'A chapter or image is too large'],
    ['download_timeout', 'The story took too long'],
    ['source_policy_blocked', 'A source request was blocked for safety'],
    ['invalid_epub', 'The downloaded EPUB could not be safely opened'],
  ])('explains %s without blaming source settings', (errorCode, message) => {
    const wrapper = mount(ImportProgress, {
      props: { job: job({ state: 'failed', errorCode, result: { progress: { stage: 'downloading', completedChapters: 17, totalChapters: 219 } } }) },
    })
    expect(wrapper.get('[role="alert"]').text()).toContain(message)
    expect(wrapper.text()).toContain('17 of 219 chapters downloaded')
    expect(wrapper.text()).not.toContain('Check your source settings')
    wrapper.unmount()
  })
  it('shows actual chapter counts and accessible download progress', () => {
    const wrapper = mount(ImportProgress, { props: { job: job() } })
    expect(wrapper.text()).toContain('12 of 40 chapters downloaded')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('30')
    wrapper.unmount()
  })
  it('keeps publication indeterminate after the download finishes', () => {
    const wrapper = mount(ImportProgress, {
      props: { job: job({ result: { progress: { stage: 'importing', completedChapters: 40, totalChapters: 40 } } }) },
    })
    expect(wrapper.text()).toContain('Adding to library')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined()
    wrapper.unmount()
  })
  it('shows the failed stage and a readable fallback for unknown errors', () => {
    const wrapper = mount(ImportProgress, { props: { job: job({ state: 'failed', errorCode: 'unknown_future_error' }) } })
    expect(wrapper.text()).toContain('Stopped while: Downloading chapters')
    expect(wrapper.get('[role="alert"]').text()).toContain('Retry')
    expect(wrapper.text()).not.toContain('unknown_future_error')
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('distinguishes automatic retries from running downloads', () => {
    const wrapper = mount(ImportProgress, { props: { job: job({ state: 'queued', attempts: 2 }) } })
    expect(wrapper.text()).toContain('Waiting to retry automatically')
    expect(wrapper.text()).toContain('Attempt 2 of 3')
    wrapper.unmount()
  })
})

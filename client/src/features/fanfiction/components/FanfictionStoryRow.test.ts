import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { FanfictionJob, FanfictionSource } from '@bookorbit/types'
import FanfictionStoryRow from './FanfictionStoryRow.vue'

const source = {
  id: 'source',
  bookId: 2,
  bookFileId: 3,
  title: 'A story',
  authors: ['Writer'],
  site: 'archiveofourown.org',
  chapterCount: 10,
  wordCount: 24000,
  state: 'active',
  storyStatus: 'Complete',
  lastCheckedAt: null,
} as FanfictionSource
const props = { source, pending: false, disabled: false, selectionDisabled: false, selected: false }
const global = { stubs: { RouterLink: { name: 'RouterLink', props: ['to'], template: '<a><slot /></a>' } } }

describe('story row feedback', () => {
  it('announces queued and completed checks in place, with duplicate checking disabled', async () => {
    const wrapper = mount(FanfictionStoryRow, { props: { ...props, pending: true }, global })
    expect(wrapper.get('[role="status"]').text()).toBe('Checking story…')
    const check = wrapper.findAll('button').find((button) => button.text() === 'Check for new chapters')!
    expect(check.attributes('disabled')).toBeDefined()
    await wrapper.setProps({ pending: false, job: { state: 'no_change', kind: 'update' } as FanfictionJob })
    expect(wrapper.get('[role="status"]').text()).toBe('No new chapters')
    expect(check.attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('opens the saved source login directly and pluralizes a single chapter', async () => {
    const wrapper = mount(FanfictionStoryRow, {
      props: {
        ...props,
        source: {
          ...source,
          chapterCount: 1,
          storyStatus: '',
          state: 'configuration_blocked',
          attentionCode: 'authentication_required',
          profileId: 'profile',
        },
      },
      global,
    })
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Update website login')!
      .trigger('click')
    expect(wrapper.emitted('fixLogin')).toEqual([['source']])
    expect(wrapper.text()).toContain('1 chapter')
    expect(wrapper.text()).not.toContain('1 chapters')
    wrapper.unmount()
  })

  it('offers the same direct login action when a story has no saved profile', async () => {
    const wrapper = mount(FanfictionStoryRow, {
      props: { ...props, source: { ...source, profileId: null, state: 'configuration_blocked', attentionCode: 'authentication_required' } },
      global,
    })
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Update website login')!
      .trigger('click')
    expect(wrapper.emitted('fixLogin')).toEqual([['source']])
    expect(wrapper.text()).not.toContain('Review story updates')
    expect(wrapper.text()).not.toContain('source settings')
    wrapper.unmount()
  })
})

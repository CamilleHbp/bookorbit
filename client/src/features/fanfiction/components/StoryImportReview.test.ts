import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { FanfictionJob } from '@bookorbit/types'
import { api } from '@/lib/api'
import StoryImportReview from './StoryImportReview.vue'
vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
describe('initial story review', () => {
  it('edits and saves a deferred import without importing it', async () => {
    const values = { title: 'Source title', description: '', authors: ['Author'], tags: ['Source tag'] }
    const job = { id: 'job', libraryId: 5, state: 'review_required', result: { importReview: { values, approved: false } } } as FanfictionJob
    vi.mocked(api).mockResolvedValue(new Response(JSON.stringify(job)))
    const wrapper = mount(StoryImportReview, { props: { job } })
    await wrapper.get('input').setValue('My title')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Review later')!
      .trigger('click')
    await flushPromises()
    const request = vi.mocked(api).mock.calls.at(-1)!
    expect(request[0]).toBe('/api/v1/libraries/5/fanfiction/jobs/job/import-review')
    expect(JSON.parse(request[1]!.body as string)).toMatchObject({ action: 'later', values: { title: 'My title' } })
    expect(wrapper.find('form').exists()).toBe(false)
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('input').element.value).toBe('My title')
    wrapper.unmount()
  })
})

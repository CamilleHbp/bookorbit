import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { FanfictionJob, FanfictionMetadataValues } from '@bookorbit/types'
import { api } from '@/lib/api'
import RichDescriptionEditor from '@/features/book/components/detail/tabs/RichDescriptionEditor.vue'
import StoryImportReview from './StoryImportReview.vue'
vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
function makeJob(values: FanfictionMetadataValues): FanfictionJob {
  const url = 'https://archiveofourown.org/works/123'
  return {
    id: 'job',
    libraryId: 5,
    kind: 'import',
    state: 'review_required',
    url,
    attempts: 1,
    cancellationRequested: false,
    errorCode: null,
    createdAt: '2026-10-03T00:00:00Z',
    updatedAt: '2026-10-03T00:00:00Z',
    result: {
      importReview: {
        values,
        approved: false,
        preview: { ...values, canonicalUrl: url, site: 'archiveofourown.org', chapterCount: 1, status: 'Completed' },
      },
    },
  }
}
describe('initial story review', () => {
  it('renders and preserves HTML descriptions when saving an import review', async () => {
    const description =
      'One orc slave decides to fight back.<br/><p>This quest is a remaster of <em>Orc Warlord</em>.</p><p>Enjoy Bloody Banners.</p>'
    const values = { title: 'Bloody Banners', description, authors: ['Author'], tags: [] }
    const job = makeJob(values)
    vi.mocked(api).mockResolvedValue(new Response(JSON.stringify(job)))
    const wrapper = mount(StoryImportReview, { props: { job } })
    await flushPromises()

    const editor = wrapper.get('.tiptap')
    expect(editor.find('br').exists()).toBe(true)
    expect(editor.get('em').text()).toBe('Orc Warlord')
    expect(editor.text()).not.toContain('<p>')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const request = vi.mocked(api).mock.calls.at(-1)!
    expect(JSON.parse(request[1]!.body as string)).toMatchObject({ action: 'apply', values: { description } })
    wrapper.unmount()
  })

  it('edits and saves a deferred import without importing it', async () => {
    const values = { title: 'Source title', description: '', authors: ['Author'], tags: ['Source tag'] }
    const job = makeJob(values)
    vi.mocked(api).mockResolvedValue(new Response(JSON.stringify(job)))
    const wrapper = mount(StoryImportReview, { props: { job } })
    await wrapper.get('input').setValue('My title')
    wrapper.getComponent(RichDescriptionEditor).vm.$emit('update:modelValue', '<p>My <em>description</em></p>')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Review later')!
      .trigger('click')
    await flushPromises()
    const request = vi.mocked(api).mock.calls.at(-1)!
    expect(request[0]).toBe('/api/v1/libraries/5/fanfiction/jobs/job/import-review')
    expect(JSON.parse(request[1]!.body as string)).toMatchObject({
      action: 'later',
      values: { title: 'My title', description: '<p>My <em>description</em></p>' },
    })
    expect(wrapper.find('form').exists()).toBe(false)
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('input').element.value).toBe('My title')
    await flushPromises()
    expect(wrapper.get('.tiptap em').text()).toBe('description')
    await wrapper.setProps({ disabled: true })
    expect(wrapper.get('.tiptap').attributes('contenteditable')).toBe('false')
    wrapper.unmount()
  })
})

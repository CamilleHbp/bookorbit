import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FanfictionPreview } from '@bookorbit/types'
import StoryPreviewModal from './StoryPreviewModal.vue'
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
const preview = {
  title: 'A story',
  authors: ['Writer'],
  description: '<p>A summary</p><p>More text</p>',
  tags: ['Adventure'],
  site: 'fiction.live',
  chapterCount: 4,
  wordCount: 1234,
} as FanfictionPreview
const wrappers: ReturnType<typeof mount>[] = []
function create() {
  const wrapper = mount(StoryPreviewModal, { props: { preview, busy: false, locked: false, error: '' }, global: { stubs: { Teleport: true } } })
  wrappers.push(wrapper)
  return wrapper
}
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
})
describe('story preview modal', () => {
  it('shows story data and confirms without rewriting unchanged metadata', async () => {
    const wrapper = create()
    expect(wrapper.get('[role="dialog"]').text()).toContain('A story')
    expect(wrapper.text()).toContain('A summary\nMore text')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('confirm')).toEqual([[{}]])
  })
  it('allows editing title, authors, description and tags before confirming', async () => {
    const wrapper = create()
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('editStoryData'))!
      .trigger('click')
    await wrapper.get('input').setValue('Edited story')
    const fields = wrapper.findAll('textarea')
    await fields[0]!.setValue('New writer\nAnother writer')
    await fields[1]!.setValue('My summary')
    await fields[2]!.setValue('New tag\nNew tag')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('confirm')).toEqual([
      [{ title: 'Edited story', authors: ['New writer', 'Another writer'], description: 'My summary', tags: ['New tag'] }],
    ])
    await wrapper.get('input').setValue(' ')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })
  it('cancels with button or Escape and blocks confirmation while busy', async () => {
    const wrapper = create()
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('cancel'))!
      .trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('cancel')).toHaveLength(2)
    expect(wrapper.emitted('confirm')).toBeUndefined()
    await wrapper.setProps({ busy: true })
    await wrapper.get('form').trigger('submit')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('cancel')).toHaveLength(2)
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })
})

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StoryMetadataReview from './StoryMetadataReview.vue'
const review = {
  current: { title: 'Title', description: '', authors: [], tags: ['Custom tag'] },
  incoming: { title: 'Title', description: '', authors: [], tags: ['Incoming tag'] },
  fields: ['tags'] as const,
  lockedFields: [] as string[],
  fingerprint: 'hash',
  previousState: 'active' as const,
}
describe('story metadata review', () => {
  it('shows both tag lists and offers an explicit merge', async () => {
    const wrapper = mount(StoryMetadataReview, {
      props: {
        review: { ...review, fields: ['tags'] },
        busy: false,
        modelValue: { title: 'keep', description: 'keep', authors: 'keep', tags: 'keep' },
      },
    })
    expect(wrapper.text()).toContain('Custom tag')
    expect(wrapper.text()).toContain('Incoming tag')
    expect(wrapper.text()).toContain('Merge tags')
    await wrapper.get('select').setValue('merge')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('save')).toHaveLength(1)
    wrapper.unmount()
  })
  it('keeps locked metadata disabled', () => {
    const wrapper = mount(StoryMetadataReview, {
      props: {
        review: { ...review, fields: ['tags'], lockedFields: ['tags'] },
        busy: false,
        modelValue: { title: 'keep', description: 'keep', authors: 'keep', tags: 'keep' },
      },
    })
    expect(wrapper.get('select').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('This field is locked')
    wrapper.unmount()
  })
})

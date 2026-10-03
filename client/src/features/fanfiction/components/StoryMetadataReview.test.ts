import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RichDescriptionEditor from '@/features/book/components/detail/tabs/RichDescriptionEditor.vue'
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
  it('renders sanitized current, incoming and final descriptions', async () => {
    const wrapper = mount(StoryMetadataReview, {
      props: {
        review: {
          ...review,
          current: { ...review.current, description: '<p>Current <em>description</em>.</p>' },
          incoming: {
            ...review.incoming,
            description:
              '<p onclick="alert(1)">Bloody Banners<br/>Orc Rebel Quest</p><script>alert(1)</script><a href="javascript:alert(1)">Link</a>',
          },
          fields: ['description'],
        },
        busy: false,
        modelValue: { title: 'keep', description: 'incoming', authors: 'keep', tags: 'keep' },
      },
    })

    const descriptions = wrapper.findAll('[data-test="story-description"]')
    expect(descriptions).toHaveLength(3)
    expect(descriptions[0]!.get('em').text()).toBe('description')
    for (const description of descriptions.slice(1)) {
      expect(description.find('br').exists()).toBe(true)
      expect(description.text()).toContain('Bloody Banners')
      expect(description.text()).not.toContain('<p')
      expect(description.find('script, [onclick], [href]').exists()).toBe(false)
    }
    await wrapper.setProps({ modelValue: { title: 'keep', description: 'keep', authors: 'keep', tags: 'keep' } })
    expect(wrapper.findAll('[data-test="story-description"]')[2]!.get('em').text()).toBe('description')
    wrapper.unmount()
  })

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
    expect(wrapper.text()).toContain('Combine tags')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Combine tags')!
      .trigger('click')
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
    expect(wrapper.get('input').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('This field is locked')
    wrapper.unmount()
  })

  it('edits formatted descriptions and keeps empty values compatible with the API', async () => {
    const wrapper = mount(StoryMetadataReview, {
      props: {
        review: { ...review, fields: ['description'] },
        busy: false,
        modelValue: {
          title: 'keep',
          description: 'edit',
          authors: 'keep',
          tags: 'keep',
          values: { ...review.current, description: '<p>Editable <strong>description</strong></p>' },
        },
      },
    })
    await flushPromises()
    expect(wrapper.get('.tiptap strong').text()).toBe('description')
    const editor = wrapper.getComponent(RichDescriptionEditor)
    editor.vm.$emit('update:modelValue', '<p>Revised <em>description</em></p>')
    await flushPromises()
    expect(wrapper.findAll('[data-test="story-description"]')[2]!.get('em').text()).toBe('description')
    editor.vm.$emit('update:modelValue', null)
    await wrapper.get('form').trigger('submit')
    expect(wrapper.props('modelValue').values?.description).toBe('')
    expect(wrapper.emitted('save')).toHaveLength(1)

    await wrapper.setProps({ busy: true })
    expect(wrapper.get('.tiptap').attributes('contenteditable')).toBe('false')
    await wrapper.setProps({ busy: false, review: { ...review, fields: ['description'], lockedFields: ['description'] } })
    expect(wrapper.get('.tiptap').attributes('contenteditable')).toBe('false')
    wrapper.unmount()
  })
})

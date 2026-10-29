import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StoryDescription from './StoryDescription.vue'

describe('story description', () => {
  it('removes source wrapper padding while preserving HTML paragraphs and inline formatting', () => {
    const wrapper = mount(StoryDescription, {
      props: {
        description:
          '<div class="userstuff">\n            <p>Minato seals the Kyubi\'s power.</p>\n            <p>A <em>second</em> paragraph.</p>\n          </div>',
      },
    })

    expect(wrapper.element.textContent).toMatch(/^Minato seals/)
    expect(wrapper.element.textContent).toMatch(/paragraph\.$/)
    expect(wrapper.findAll('p')).toHaveLength(2)
    expect(wrapper.get('em').text()).toBe('second')
    wrapper.unmount()
  })

  it('preserves internal plain-text line breaks while trimming the edges', () => {
    const wrapper = mount(StoryDescription, { props: { description: '\n  First line.\nSecond line.\n\nAnother paragraph.\n  ' } })

    expect(wrapper.element.textContent).toBe('First line.\nSecond line.\n\nAnother paragraph.')
    wrapper.unmount()
  })
})

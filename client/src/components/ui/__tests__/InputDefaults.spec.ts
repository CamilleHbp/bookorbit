import { compile, defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { inputDefaults } from '../../../../input-defaults'

function render(template: string) {
  return mount(defineComponent({ render: compile(template, { nodeTransforms: [inputDefaults] }) }))
}

describe('input text assistance', () => {
  it('disables native suggestions for short fields, including dynamically typed inputs', () => {
    const wrapper = render('<div><input /><input type="search" /><input :type="\'text\'" /></div>')
    for (const input of wrapper.findAll('input')) {
      expect(input.attributes()).toMatchObject({ autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false' })
    }
  })

  it('preserves credential autofill and explicit field settings', () => {
    const wrapper = render('<input autocomplete="username" :autocorrect="\'off\'" autocapitalize="none" :spellcheck="false" />')
    expect(wrapper.attributes()).toMatchObject({ autocomplete: 'username', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false' })
  })

  it('keeps writing assistance available for prose and rich descriptions', () => {
    const wrapper = render('<div><textarea /><div contenteditable="true" /></div>')
    for (const field of [wrapper.get('textarea'), wrapper.get('[contenteditable]')]) {
      expect(field.attributes('autocorrect')).toBeUndefined()
      expect(field.attributes('spellcheck')).toBeUndefined()
    }
  })

  it('disables correction for multiline identifiers and configuration', () => {
    const wrapper = render('<textarea spellcheck="false" />')
    expect(wrapper.attributes()).toMatchObject({ autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false' })
  })

  it('leaves non-text controls alone', () => {
    const wrapper = render('<input type="checkbox" />')
    expect(wrapper.attributes('autocorrect')).toBeUndefined()
  })
})

import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ChipInput from '../ChipInput.vue'

function mountInput(props: Partial<InstanceType<typeof ChipInput>['$props']> = {}) {
  return mount(ChipInput, { props: { modelValue: [], ...props } })
}

function typeInto(wrapper: ReturnType<typeof mountInput>, value: string) {
  const input = wrapper.find('input')
  ;(input.element as HTMLInputElement).value = value
  return input.trigger('input')
}

describe('ChipInput', () => {
  it('hides a custom example placeholder after a chip has been added', async () => {
    const wrapper = mountInput({ placeholder: '7020' })

    expect(wrapper.find('input').attributes('placeholder')).toBe('7020')

    await wrapper.setProps({ modelValue: ['333'] })

    expect(wrapper.find('input').attributes('placeholder')).toBe('')
  })

  /** Without a search function the field is a plain list, which is what a settings form needs. */
  it('adds what was typed on Enter when no suggestions are configured', async () => {
    const wrapper = mountInput()

    await typeInto(wrapper, 'epub')
    await wrapper.find('input').trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['epub']])
  })

  /** These values are written down comma-separated, so that is how they get pasted in. */
  it('splits a pasted comma-separated list, keeping whatever is still being typed', async () => {
    const wrapper = mountInput()

    await typeInto(wrapper, 'epub, mobi, azw')

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['epub', 'mobi']])
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe(' azw')
  })

  it('refuses an entry the field says is not valid', async () => {
    const normalize = vi.fn<(raw: string) => string | null>((raw) => (/^\d+$/.test(raw) ? raw : null))
    const wrapper = mountInput({ normalize })

    await typeInto(wrapper, '7020,notanumber,')

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['7020']])
  })

  it('does not add the same entry twice', async () => {
    const wrapper = mountInput({ modelValue: ['epub'] })

    await typeInto(wrapper, 'epub')
    await wrapper.find('input').trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('drops the last entry on Backspace in an empty box', async () => {
    const wrapper = mountInput({ modelValue: ['epub', 'mobi'] })

    await wrapper.find('input').trigger('keydown', { key: 'Backspace' })

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['epub']])
  })

  /** A suggestion-backed field must keep working exactly as it did before free text was allowed. */
  it('still queries the search function when one is given', async () => {
    vi.useFakeTimers()
    const searchFn = vi.fn<(q: string) => Promise<string[]>>().mockResolvedValue(['fiction'])
    const wrapper = mountInput({ searchFn })

    await typeInto(wrapper, 'fic')
    await vi.advanceTimersByTimeAsync(250)

    expect(searchFn).toHaveBeenCalledWith('fic')
    vi.useRealTimers()
  })
})

describe('tag editing and suggestions', () => {
  it('waits for three characters and selects suggestions with the keyboard', async () => {
    vi.useFakeTimers()
    const searchFn = vi.fn<(query: string) => Promise<string[]>>().mockResolvedValue(['Adventure'])
    const wrapper = mountInput({ searchFn, minSearchLength: 3 })
    try {
      await typeInto(wrapper, 'Ad')
      await vi.advanceTimersByTimeAsync(250)
      expect(searchFn).not.toHaveBeenCalled()
      await typeInto(wrapper, 'Adv')
      await vi.advanceTimersByTimeAsync(250)
      await wrapper.get('input').trigger('keydown', { key: 'ArrowDown' })
      await wrapper.get('input').trigger('keydown', { key: 'Enter' })
      expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['Adventure']])
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })
  it('ignores stale results after the search is cleared', async () => {
    vi.useFakeTimers()
    let resolve!: (value: string[]) => void
    const wrapper = mountInput({
      searchFn: () =>
        new Promise((done) => {
          resolve = done
        }),
    })
    try {
      await typeInto(wrapper, 'Adv')
      await vi.advanceTimersByTimeAsync(250)
      await typeInto(wrapper, '')
      resolve(['Adventure'])
      await vi.advanceTimersByTimeAsync(1)
      expect(wrapper.get('input').attributes('aria-expanded')).toBe('false')
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })
  it('commits a pending tag when the field loses focus', async () => {
    const wrapper = mountInput({ modelValue: ['Adventure'] })
    await typeInto(wrapper, 'Fantasy')
    await wrapper.get('input').trigger('blur')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['Adventure', 'Fantasy']])
    wrapper.unmount()
  })
})

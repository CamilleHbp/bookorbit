import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { FanfictionMetadataChoices, FanfictionMetadataReview } from '@bookorbit/types'
import RichDescriptionEditor from '@/features/book/components/detail/tabs/RichDescriptionEditor.vue'
import StoryMetadataReview from './StoryMetadataReview.vue'
import ChipInput from '@/components/ui/ChipInput.vue'
import { api } from '@/lib/api'
vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const review: FanfictionMetadataReview = {
  current: {
    title: 'Library title',
    description: '<p>Library description</p>',
    authors: ['Library author'],
    genres: ['Fantasy'],
    tags: ['Custom tag'],
  },
  incoming: {
    title: 'Incoming title',
    description: '<p>Incoming description</p>',
    authors: ['Incoming author'],
    genres: ['Adventure'],
    tags: ['Incoming tag'],
  },
  fields: ['description'],
  lockedFields: ['title', 'description', 'authors', 'genres', 'tags'],
  fingerprint: 'hash',
  previousState: 'active',
}
function open(overrides: Partial<FanfictionMetadataReview> = {}, model: Partial<FanfictionMetadataChoices> = {}) {
  const wrapper = mount(StoryMetadataReview, {
    props: {
      review: { ...review, ...overrides },
      busy: false,
      modelValue: { title: 'keep', description: 'keep', authors: 'keep', genres: 'keep', tags: 'keep', ...model },
      'onUpdate:modelValue': (value) => {
        void wrapper.setProps({ modelValue: value })
      },
    },
  })
  return wrapper
}
describe('story metadata review', () => {
  it('renders sanitized source descriptions and an always editable final description', async () => {
    const wrapper = open(
      { incoming: { ...review.incoming, description: '<p onclick="alert(1)">Incoming<br/>description</p><script>alert(1)</script>' } },
      { description: 'incoming' },
    )
    await flushPromises()
    const descriptions = wrapper.findAll('[data-test="story-description"]')
    expect(descriptions).toHaveLength(2)
    expect(descriptions[1]!.find('br').exists()).toBe(true)
    expect(wrapper.find('script, [onclick]').exists()).toBe(false)
    expect(wrapper.get('.tiptap').attributes('contenteditable')).toBe('true')
    expect(wrapper.get('.tiptap').text()).toContain('Incoming')
    wrapper.unmount()
  })

  it('shows all final inputs and resets each one when either source is chosen, including protected fields', async () => {
    const wrapper = open()
    await flushPromises()
    expect(wrapper.findAll('legend').map((field) => field.text())).toEqual(['Title', 'Authors', 'Description', 'Genres', 'Tags'])
    expect(wrapper.findAll('input')).toHaveLength(4)
    expect(wrapper.findAll('input[disabled]')).toHaveLength(0)
    expect(wrapper.text()).toContain('Protected from automatic updates. You can still edit it here.')
    for (const [index, field] of (['title', 'authors', 'description', 'genres', 'tags'] as const).entries()) {
      const group = wrapper.findAll('fieldset')[index]!
      const choose = async (label: string) =>
        group
          .findAll('button')
          .find((button) => button.text() === label)!
          .trigger('click')
      const value = () => {
        if (field === 'description') return group.getComponent(RichDescriptionEditor).props('modelValue')
        if (field === 'title') return group.get('input').element.value
        return group.getComponent(ChipInput).props('modelValue')
      }
      await choose('Use incoming')
      await flushPromises()
      expect(value()).toEqual(review.incoming[field])
      if (field === 'description') group.getComponent(RichDescriptionEditor).vm.$emit('update:modelValue', '<p>My description</p>')
      else await group.get('input').setValue('Uncommitted edit')
      await choose('Use library')
      await flushPromises()
      expect(value()).toEqual(review.current[field])
    }
    expect(review.current.tags).toEqual(['Custom tag'])
    wrapper.unmount()
  })

  it.each(['authors', 'genres', 'tags'] as const)('edits and combines %s without keeping stale input', async (field) => {
    const wrapper = open()
    const group = wrapper.findAll('fieldset')[['title', 'authors', 'description', 'genres', 'tags'].indexOf(field)]!
    const choose = async (label: string) =>
      group
        .findAll('button')
        .find((button) => button.text() === label)!
        .trigger('click')
    await group.get('input').setValue('My addition')
    await group.get('input').trigger('keydown', { key: 'Enter' })
    expect(group.getComponent(ChipInput).props('modelValue')).toEqual([...review.current[field]!, 'My addition'])
    await group.get('input').setValue('Uncommitted addition')
    await choose('Use incoming')
    expect(group.get('input').element.value).toBe('')
    expect(group.getComponent(ChipInput).props('modelValue')).toEqual(review.incoming[field])
    await choose('Combine')
    expect(group.getComponent(ChipInput).props('modelValue')).toEqual([...review.current[field]!, ...review.incoming[field]!])
    wrapper.unmount()
  })

  it.each(['tags', 'genres'] as const)('autocompletes %s and saves a new value typed before saving', async (field) => {
    const wrapper = open()
    const group = wrapper.findAll('fieldset')[field === 'tags' ? 4 : 3]!
    const input = group.getComponent(ChipInput)
    vi.mocked(api).mockResolvedValue(new Response(JSON.stringify([{ name: 'Library suggestion' }])))
    vi.useFakeTimers()
    try {
      await input.get('input').setValue('Lib')
      await vi.advanceTimersByTimeAsync(250)
      await flushPromises()
      expect(api).toHaveBeenCalledWith(`/api/v1/metadata/${field}?q=Lib`)
      expect(document.querySelector('[role="option"]')?.textContent).toBe('Library suggestion')
      await input.get('input').trigger('keydown', { key: 'ArrowDown' })
      await input.get('input').trigger('keydown', { key: 'Enter' })
      expect(input.props('modelValue')).toEqual([...review.current[field]!, 'Library suggestion'])
      await input.get('input').setValue('My new value')
      await wrapper.get('form').trigger('submit')
      await flushPromises()
      const choices = wrapper.props('modelValue')
      expect(field === 'tags' ? choices.selectedTags : choices.values?.genres).toEqual([
        ...review.current[field]!,
        'Library suggestion',
        'My new value',
      ])
      expect(choices[field]).toBe('edit')
      expect(wrapper.emitted('save')).toHaveLength(1)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('commits pending text in multiple fields without losing earlier changes', async () => {
    const wrapper = open()
    for (const input of wrapper.findAllComponents(ChipInput)) await input.get('input').setValue('New entry')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.props('modelValue').values?.authors).toEqual(['Library author', 'New entry'])
    expect(wrapper.props('modelValue').values?.genres).toEqual(['Fantasy', 'New entry'])
    expect(wrapper.props('modelValue').selectedTags).toEqual(['Custom tag', 'New entry'])
    wrapper.unmount()
  })

  it('restores saved edits, supports clearing fields and only disables edits while busy', async () => {
    const wrapper = open({}, { description: 'edit', values: { ...review.current, description: '<p>Saved <strong>draft</strong></p>' } })
    await flushPromises()
    expect(wrapper.get('.tiptap strong').text()).toBe('draft')
    wrapper.getComponent(RichDescriptionEditor).vm.$emit('update:modelValue', null)
    await flushPromises()
    expect(wrapper.props('modelValue').values?.description).toBe('')
    await wrapper.setProps({ busy: true })
    expect(wrapper.get('.tiptap').attributes('contenteditable')).toBe('false')
    expect(wrapper.findAll('input[disabled]')).toHaveLength(4)
    wrapper.unmount()
  })

  it('keeps long source lists compact and lets users inspect every value', async () => {
    const wrapper = open({ incoming: { ...review.incoming, tags: Array.from({ length: 200 }, (_, i) => `Tag ${i}`) } })
    const group = wrapper.findAll('fieldset')[4]!
    expect(group.findAll('li')).toHaveLength(7)
    const expand = group.findAll('button').find((button) => button.text() === 'Show 194 more')!
    await expand.trigger('click')
    expect(group.findAll('li')).toHaveLength(201)
    expect(expand.attributes('aria-expanded')).toBe('true')
    await expand.trigger('click')
    expect(group.findAll('li')).toHaveLength(7)
    wrapper.unmount()
  })
})

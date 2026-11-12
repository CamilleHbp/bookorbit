import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import DownloadQueue from './DownloadQueue.vue'

const snapshot = ref()
vi.mock('../composables/useDownloadQueue', () => ({
  sections: ['attention'],
  useDownloadQueue: () => ({ snapshot, offsets: { attention: 0 }, reload: vi.fn<() => void>(), refresh: vi.fn<() => void>() }),
}))
afterEach(() => {
  snapshot.value = undefined
})

it('offers verification beside the affected download without opening a dialog or repeating the link', async () => {
  const wrapper = mount(DownloadQueue, {
    props: { libraryId: 1 },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  })
  try {
    const row = {
      section: 'attention',
      site: 'fanfiction.net',
      code: 'fanfiction_net_browser_verification',
      id: 'story',
      title: 'A story',
      verificationUrl: 'https://example.org/s/123',
    }
    snapshot.value = { items: [row], recent: [], totals: { attention: 1 } }
    await flushPromises()
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(wrapper.find('a[target="_blank"]').exists()).toBe(false)
    snapshot.value.items[0].verificationUrl = 'https://www.fanfiction.net/s/123/1'
    await flushPromises()
    const links = wrapper.findAll('a[target="_blank"]')
    expect(links).toHaveLength(1)
    expect(links[0]!.attributes('href')).toBe('https://www.fanfiction.net/s/123/1')
    expect(links[0]!.attributes('rel')).toBe('noopener noreferrer')
    expect(wrapper.get('article').text()).toContain('A story')
    expect(wrapper.find('dialog').exists()).toBe(false)
  } finally {
    wrapper.unmount()
  }
})

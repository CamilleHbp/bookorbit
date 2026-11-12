import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { expect, it, vi } from 'vitest'
import DownloadQueue from './DownloadQueue.vue'

const snapshot = ref()
vi.mock('../composables/useDownloadQueue', () => ({
  sections: [],
  useDownloadQueue: () => ({ snapshot, offsets: {}, reload: vi.fn(), refresh: vi.fn() }),
}))

it('prompts on a challenged story, ignores an unrelated origin, and leaves a link after dismissal', async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.open = false
    },
  })
  const wrapper = mount(DownloadQueue, { props: { libraryId: 1 } })
  try {
    const row = {
      site: 'fanfiction.net',
      code: 'fanfiction_net_browser_verification',
      id: 'group',
      jobId: 'job',
      verificationUrl: 'https://example.org/s/123',
    }
    snapshot.value = { items: [row], recent: [], totals: {} }
    await flushPromises()
    expect(wrapper.get('dialog').attributes('open')).toBeUndefined()
    snapshot.value.items[0].verificationUrl = 'https://www.fanfiction.net/s/123/1'
    await flushPromises()
    expect(wrapper.get('dialog').attributes('open')).toBeDefined()
    await wrapper.get('dialog button').trigger('click')
    expect(wrapper.get('dialog').attributes('open')).toBeUndefined()
    expect(wrapper.get('a').attributes('href')).toBe('https://www.fanfiction.net/s/123/1')
  } finally {
    wrapper.unmount()
  }
})

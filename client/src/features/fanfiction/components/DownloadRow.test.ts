import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { FanfictionDownloadRow } from '@bookorbit/types'
import DownloadRow from './DownloadRow.vue'

describe('download wait explanations', () => {
  it('explains an unrevealed work instead of showing a generic website failure', () => {
    const row: FanfictionDownloadRow = {
      id: 'hidden-story',
      section: 'retrying',
      issue: 'website',
      groupKey: null,
      count: 1,
      jobId: 'hidden-job',
      sourceId: 'saved-source',
      bookId: 1,
      site: 'archiveofourown.org',
      title: 'Saved story',
      kind: 'update',
      code: 'source_unrevealed',
      nextAttemptAt: '2026-11-17T12:00:00Z',
      progress: null,
      removed: 0,
      changed: 0,
      reordered: false,
      currentChapters: 10,
      proposedChapters: null,
    }
    const wrapper = mount(DownloadRow, {
      props: { row, libraryId: 1 },
      global: { stubs: { RouterLink: true, RetryDownloadsButton: true, DownloadGroupMembers: true } },
    })
    expect(wrapper.text()).toContain('hidden in an unrevealed collection')
    expect(wrapper.text()).toContain('Your saved copy is still available')
    expect(wrapper.text()).toContain('check again tomorrow')
    wrapper.unmount()
  })
})

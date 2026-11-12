import { describe, expect, it } from 'vitest'
import { FANFICTION_WEBSITE_ACCESS_ERRORS, type FanfictionDownloadRow, type FanfictionSource } from '@bookorbit/types'
import { canReviewDownload, canReviewStory, storyIssueRoute, storyReviewRoute } from './storyReview'

describe('story repair routing', () => {
  it.each([...FANFICTION_WEBSITE_ACCESS_ERRORS])('keeps %s out of review even with pending metadata', (code) => {
    expect(canReviewStory({ bookId: 2, state: 'review_required', metadataReviewPending: true, attentionCode: code } as FanfictionSource)).toBe(false)
    expect(canReviewDownload({ bookId: 2, section: 'attention', issue: 'metadata', code } as FanfictionDownloadRow)).toBe(false)
    expect(storyIssueRoute(1, 'source', 2, code)).toEqual({ name: 'settings-website-logins' })
  })
  it.each(['metadata_review_required', 'content_review_required', 'source_chapter_reduction', 'source_not_found'])(
    'opens %s on the selected story in the queue',
    (code) => {
      expect(canReviewStory({ bookId: 2, state: 'review_required', attentionCode: code } as FanfictionSource)).toBe(true)
      expect(storyIssueRoute(1, 'source', 2, code)).toEqual(storyReviewRoute(1, 'source', 2))
    },
  )
  it('keeps unfinished imports in the import inbox', () => {
    expect(storyIssueRoute(1, null, null, 'import_review_required')).toEqual({
      name: 'fanfiction',
      query: { tab: 'review', review: 'imports', libraryId: 1 },
    })
  })
})

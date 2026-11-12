import { isFanfictionWebsiteAccessProblem, type FanfictionDownloadRow, type FanfictionSource } from '@bookorbit/types'

export function storyReviewRoute(libraryId: number, sourceId?: string | null, bookId?: number | null) {
  return {
    name: 'fanfiction',
    query: { tab: 'review', review: 'attention', libraryId, sourceId: sourceId || undefined, bookId: bookId || undefined },
  }
}

export function canReviewStory(source: FanfictionSource) {
  return Boolean(
    source.bookId &&
    source.state !== 'unlinked' &&
    !isFanfictionWebsiteAccessProblem(source.attentionCode) &&
    (source.metadataReviewPending || source.attentionCode || ['review_required', 'configuration_blocked'].includes(source.state)),
  )
}

export function canReviewDownload(row: FanfictionDownloadRow) {
  return Boolean(
    row.section === 'attention' && row.bookId && row.issue !== 'website' && row.issue !== 'login' && !isFanfictionWebsiteAccessProblem(row.code),
  )
}

export function storyIssueRoute(libraryId: number, sourceId: string | null | undefined, bookId: number | null | undefined, code?: string | null) {
  if (isFanfictionWebsiteAccessProblem(code)) return { name: 'settings-website-logins' }
  if (!bookId) return { name: 'fanfiction', query: { tab: 'review', review: 'imports', libraryId } }
  return storyReviewRoute(libraryId, sourceId, bookId)
}

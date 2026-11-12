import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { FANFICTION_WEBSITE_ACCESS_ERRORS, type FanfictionReviewScope, type FanfictionSourceState } from '@bookorbit/types';
import { fanfictionSources as sources } from '../../db/schema';
import { connectionAccessErrors } from './fanfiction-website';

export function storyStateFilter(state?: FanfictionSourceState | null) {
  if (state === 'active' || state === 'paused') {
    return and(ne(sources.state, 'unlinked'), eq(sources.updatesEnabled, state === 'active'));
  }
  return state ? eq(sources.state, state) : undefined;
}

export function personalAccessIssueFilter(userId: number, site?: string) {
  return and(
    site ? eq(sources.site, site) : undefined,
    eq(sources.maintainerUserId, userId),
    eq(sources.updatesEnabled, true),
    ne(sources.state, 'unlinked'),
    inArray(sources.attentionCode, [...connectionAccessErrors]),
  );
}

export function storyReviewFilter(scope?: FanfictionReviewScope) {
  if (!scope) return undefined;
  return and(
    sql`${sources.bookId} is not null`,
    ne(sources.state, 'unlinked'),
    sql`not coalesce(${inArray(sources.attentionCode, [...FANFICTION_WEBSITE_ACCESS_ERRORS])}, false)`,
    scope === 'pending' ? sql`(${sources.metadataReviewPending} or ${sources.attentionCode} = 'metadata_review_required')` : undefined,
    scope === 'attention'
      ? sql`(${sources.metadataReviewPending} or ${sources.attentionCode} is not null or ${sources.state} in ('review_required', 'configuration_blocked'))`
      : undefined,
  );
}

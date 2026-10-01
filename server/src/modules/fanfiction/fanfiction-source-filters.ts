import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { FanfictionSourceState } from '@bookorbit/types';
import { fanfictionSources as sources } from '../../db/schema';
import { connectionAccessErrors } from './fanfiction-website';

export function storyStateFilter(state?: FanfictionSourceState | null) {
  if (state === 'active' || state === 'paused') {
    return and(ne(sources.state, 'unlinked'), sql`coalesce(${sources.updatesEnabled}, ${sources.state} <> 'paused') = ${state === 'active'}`);
  }
  return state ? eq(sources.state, state) : undefined;
}

export function personalAccessIssueFilter(userId: number, site?: string) {
  return and(
    site ? eq(sources.site, site) : undefined,
    eq(sources.maintainerUserId, userId),
    eq(sources.accessMode, 'personal'),
    eq(sources.updatesEnabled, true),
    ne(sources.state, 'unlinked'),
    inArray(sources.attentionCode, [...connectionAccessErrors]),
  );
}

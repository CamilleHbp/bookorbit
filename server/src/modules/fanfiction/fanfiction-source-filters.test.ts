import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { validateSync } from 'class-validator';
import { PgDialect } from 'drizzle-orm/pg-core';
import { FANFICTION_WEBSITE_ACCESS_ERRORS } from '@bookorbit/types';
import { ListFanfictionSourcesDto } from './dto/fanfiction-source.dto';
import { storyReviewFilter } from './fanfiction-source-filters';

describe('story review scope', () => {
  it('accepts the attention scope through DTO validation', () => {
    expect(validateSync(Object.assign(new ListFanfictionSourcesDto(), { reviewScope: 'attention' }))).toEqual([]);
  });
  it.each(['attention', 'pending', 'all'] as const)(
    'excludes every website access failure from %s while preserving null attention codes',
    (scope) => {
      const query = new PgDialect().sqlToQuery(storyReviewFilter(scope)!);
      expect(query.sql).toContain('not coalesce(');
      expect(query.sql).toContain(', false)');
      expect(query.params).toEqual(expect.arrayContaining([...FANFICTION_WEBSITE_ACCESS_ERRORS]));
      expect(query.sql).toContain('"book_id" is not null');
    },
  );
  it('does not change ordinary source listing', () => {
    expect(storyReviewFilter()).toBeUndefined();
  });
});

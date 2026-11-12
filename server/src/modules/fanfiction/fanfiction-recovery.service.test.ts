import { expect, it } from 'vitest';
import { fanfictionJobs } from '../../db/schema';
import { awaitingPublicationReview } from './fanfiction-recovery.service';
import { FanfictionSourceService } from './fanfiction-source.service';

it('keeps a proposed EPUB while its chapter edits await review, and releases it after discard', () => {
  const job = { state: 'review_required', result: { contentReview: { approved: false } } } as typeof fanfictionJobs.$inferSelect;
  expect(awaitingPublicationReview(job)).toBe(true);
  expect(awaitingPublicationReview({ ...job, cancellationRequested: true })).toBe(false);
  expect(awaitingPublicationReview({ ...job, state: 'failed' })).toBe(false);
});

it('identifies StoriesOnline books by story ID even when the title slug changes', () => {
  const source = FanfictionSourceService.prototype;
  const saved = 'https://storiesonline.net/s/22849';
  expect(source.sameStory(saved, saved + '/a-true-history-book-two')).toBe(true);
  expect(source.sameStory(saved, 'https://storiesonline.net/s/22848/a-true-history-book-two')).toBe(false);
  expect(source.sameStory(saved, 'https://example.org/s/22849')).toBe(false);
});

import { expect, it } from 'vitest';
import { fanfictionJobs } from '../../db/schema';
import { awaitingPublicationReview } from './fanfiction-recovery.service';

it('keeps a proposed EPUB while its chapter edits await review, and releases it after discard', () => {
  const job = { state: 'review_required', result: { contentReview: { approved: false } } } as typeof fanfictionJobs.$inferSelect;
  expect(awaitingPublicationReview(job)).toBe(true);
  expect(awaitingPublicationReview({ ...job, cancellationRequested: true })).toBe(false);
  expect(awaitingPublicationReview({ ...job, state: 'failed' })).toBe(false);
});

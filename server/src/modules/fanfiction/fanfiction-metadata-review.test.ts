import { describe, expect, it } from 'vitest';
import { changedStoryMetadata } from './fanfiction-metadata-review';
const current = { title: 'Story', description: 'Description', authors: ['Writer'], tags: ['Custom tag'] };
describe('story metadata review', () => {
  it('reviews incoming tags without silently overwriting custom tags', () => {
    expect(changedStoryMetadata(current, { ...current, tags: ['Incoming tag'] })).toEqual(['tags']);
  });
  it('ignores tag ordering, duplicates, whitespace and storage truncation', () => {
    const tags = ['a'.repeat(200), 'b'];
    expect(changedStoryMetadata({ ...current, tags }, { ...current, tags: [' b ', 'a'.repeat(201), 'b'] })).toEqual([]);
  });
  it('does not prompt again for a previously reviewed source value', () => {
    const incoming = { ...current, tags: ['Incoming tag'] };
    expect(changedStoryMetadata(current, incoming, incoming)).toEqual([]);
    expect(changedStoryMetadata(current, { ...incoming, tags: ['New tag'] }, incoming)).toEqual(['tags']);
  });
  it('reviews each changed scalar and ordered author list', () => {
    expect(changedStoryMetadata(current, { ...current, title: 'New title', description: '', authors: ['Other'] })).toEqual([
      'title',
      'description',
      'authors',
    ]);
  });
});

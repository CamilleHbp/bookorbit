import { describe, expect, it } from 'vitest';
import { changedStoryMetadata, planStoryMetadata } from './fanfiction-metadata-review';
const current = { title: 'Story', description: 'Description', authors: ['Writer'], tags: ['Custom tag'] };
describe('story metadata review', () => {
  it('preserves custom-only tags without treating them as conflicts', () => {
    const incoming = { ...current, tags: ['Source'] };
    expect(planStoryMetadata({ ...current, tags: ['Source', 'Custom'] }, incoming, ['Source'], [], incoming).fields).toEqual([]);
  });
  it('automatically follows unchanged library values and reviews locally edited values', () => {
    const incoming = { ...current, title: 'New source title', description: 'New source description' };
    const plan = planStoryMetadata({ ...current, description: 'My description' }, incoming, current.tags, [], current);
    expect(plan.fields).toEqual(['description']);
    expect(plan.values.title).toBe(incoming.title);
    expect(plan.values.description).toBe('My description');
  });
  it('keeps locked fields without blocking an update and remembers previously rejected values', () => {
    const incoming = { ...current, title: 'New title', tags: ['New tag'] };
    expect(planStoryMetadata(current, incoming, current.tags, ['title', 'tags'], current).fields).toEqual([]);
    expect(planStoryMetadata(current, incoming, current.tags, [], incoming).fields).toEqual([]);
  });
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

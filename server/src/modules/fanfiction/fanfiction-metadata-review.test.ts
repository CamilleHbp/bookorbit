import { describe, expect, it } from 'vitest';
import { changedStoryMetadata, planStoryMetadata, storyTagChanges, withoutExcludedTags } from './fanfiction-metadata-review';
const current = { title: 'Story', description: 'Description', authors: ['Writer'], tags: ['Custom tag'] };
describe('story metadata review', () => {
  it('omits excluded suggestions while retaining real changes and the original website preview', () => {
    const preview = { ...current, tags: ['Excluded'] };
    const incoming = withoutExcludedTags(preview, ['Excluded']);
    expect(planStoryMetadata(current, incoming, [], []).fields).toEqual([]);
    expect(storyTagChanges(current.tags, incoming.tags, [])).toEqual({ added: [], removed: [] });
    const mixed = withoutExcludedTags({ ...preview, tags: ['Excluded', 'New'] }, ['Excluded']);
    expect(planStoryMetadata(current, mixed, [], []).fields).toEqual(['tags']);
    expect(storyTagChanges(current.tags, mixed.tags, []).added).toEqual(['New']);
    expect(preview.tags).toEqual(['Excluded']);
  });
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
  it('leaves genres under manual control even when source genres change', () => {
    const library = { ...current, genres: ['Fantasy'] };
    expect(planStoryMetadata(library, { ...current, genres: ['Romance'] }, current.tags, [], library).values.genres).toEqual(['Fantasy']);
    expect(changedStoryMetadata(library, { ...library, genres: ['Romance'] })).toEqual([]);
    expect(planStoryMetadata(library, current, current.tags, [], current).values.genres).toEqual(['Fantasy']);
    expect(planStoryMetadata(library, { ...current, genres: ['Romance'] }, current.tags, ['genres'], library).values.genres).toEqual(['Fantasy']);
  });
  it('automatically follows source tags only when their field is unlocked', () => {
    const incoming = { ...current, tags: ['Incoming'] };
    const automatic = planStoryMetadata(current, incoming, current.tags, [], current, 'automatic');
    expect(automatic.fields).not.toContain('tags');
    expect(automatic.values.tags).toEqual(['Incoming']);
    expect(planStoryMetadata(current, incoming, current.tags, ['tags'], current, 'automatic').values.tags).toEqual(current.tags);
  });
});

it('adopts already assigned tags without a review or changing personal tags', () => {
  const library = { ...current, tags: ['Source', 'Existing', 'Personal'] };
  const incoming = { ...current, tags: ['Source', 'Existing'] };
  const plan = planStoryMetadata(library, incoming, ['Source'], [], { ...current, tags: ['Source'] });
  expect(plan.fields).toEqual([]);
  expect(plan.values.tags).toEqual(['Existing', 'Source']);
  expect(storyTagChanges(library.tags, incoming.tags, ['Source'])).toEqual({ added: [], removed: [] });
});
it('still reviews actual additions, managed removals and previously removed tags', () => {
  const incoming = { ...current, tags: ['Source', 'New'] };
  expect(planStoryMetadata({ ...current, tags: ['Source', 'Personal'] }, incoming, ['Source'], []).fields).toEqual(['tags']);
  expect(planStoryMetadata({ ...current, tags: ['Source', 'Personal'] }, { ...incoming, tags: [] }, ['Source'], []).fields).toEqual(['tags']);
  expect(
    planStoryMetadata({ ...current, tags: ['Personal'] }, { ...incoming, tags: ['Source'] }, ['Source'], [], { ...current, tags: ['Old'] }).fields,
  ).toEqual(['tags']);
});

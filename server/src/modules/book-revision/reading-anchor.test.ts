import { describe, expect, it } from 'vitest';
import type { ReadingAnchor, RevisionChapter } from '@bookorbit/types';
import { relocatePassage, resolveReadingAnchor } from './reading-anchor';

const chapter = (href: string, length = 100): RevisionChapter => ({ href, title: href, textHash: href, length });
const anchor = (overrides: Partial<ReadingAnchor> = {}): ReadingAnchor => ({
  revision: 'old',
  chapterIndex: 1,
  chapterHref: 'two',
  chapterFraction: 0.8,
  bookFraction: 0.9,
  ...overrides,
});

describe('cross-version reading anchors', () => {
  it('does not use a reused href for a different known source chapter', () => {
    const result = resolveReadingAnchor(anchor({ chapterSourceUrl: 'https://example.org/deleted', chapterTitle: undefined }), 'new', [
      { ...chapter('two'), sourceUrl: 'https://example.org/unrelated', textHash: 'unrelated' },
    ]);
    expect(result.reason).toBe('proportional');
  });
  it('does not guess an exact passage from repeated text without matching context', () => {
    const original = anchor({ quote: 'hello' });
    const chapters = [chapter('one'), chapter('two')];
    expect(relocatePassage(original, resolveReadingAnchor(original, 'new', chapters), 'hello hello', chapters).quality).toBe('approximate');
  });
  it('returns scalar offsets for passages after emoji', () => {
    const original = anchor({ quote: 'hello' });
    const chapters = [chapter('one'), chapter('two')];
    expect(relocatePassage(original, resolveReadingAnchor(original, 'new', chapters), '😀 hello', chapters).offset).toBe(2);
  });
  it('never treats same-revision passage search as native locator verification', () => {
    const original = anchor({ quote: 'hello' });
    const chapters = [chapter('one'), chapter('two')];
    expect(relocatePassage(original, resolveReadingAnchor(original, 'old', chapters), 'hello', chapters).quality).toBe('relocated');
  });
  it('rejects a manifest without any readable chapter', () => {
    expect(() => resolveReadingAnchor(anchor(), 'new', [])).toThrow('no readable chapters');
  });
  it('preserves the paragraph while the book percentage drops after appended chapters', () => {
    expect(resolveReadingAnchor(anchor(), 'new', [chapter('one'), chapter('two'), chapter('three')])).toMatchObject({
      chapterIndex: 1,
      chapterFraction: 0.8,
      bookFraction: 0.6,
    });
  });
  it('keeps old completion at the old ending, not the new ending', () => {
    expect(
      resolveReadingAnchor(anchor({ chapterFraction: 1, bookFraction: 1 }), 'new', [chapter('one'), chapter('two'), chapter('three')]).bookFraction,
    ).toBeCloseTo(2 / 3);
  });
  it('matches stable source URLs before changed names and order', () => {
    expect(
      resolveReadingAnchor(anchor({ chapterSourceUrl: 'https://example.org/2' }), 'new', [
        { ...chapter('renamed'), sourceUrl: 'https://example.org/2' },
        chapter('two'),
      ]).chapterIndex,
    ).toBe(0);
  });
  it('maps deleted chapters to the previous surviving boundary', () => {
    expect(
      resolveReadingAnchor(anchor(), 'new', [chapter('one'), chapter('three')], [chapter('one'), chapter('two'), chapter('three')]),
    ).toMatchObject({ chapterIndex: 0, chapterFraction: 1, reason: 'surviving_boundary' });
  });
  it('projects newer progress onto an older device without changing its canonical anchor', () => {
    const original = anchor({ chapterIndex: 2, chapterHref: 'three' });
    const copy = structuredClone(original);
    expect(
      resolveReadingAnchor(original, 'older', [chapter('one'), chapter('two')], [chapter('one'), chapter('two'), chapter('three')]),
    ).toMatchObject({ chapterIndex: 1, chapterFraction: 1 });
    expect(original).toEqual(copy);
  });
  it('automatically falls back to a clamped proportion for legacy positions', () => {
    expect(resolveReadingAnchor(anchor({ chapterHref: undefined, bookFraction: 3 }), 'new', [chapter('x')])).toMatchObject({
      chapterIndex: 0,
      chapterFraction: 1,
      bookFraction: 1,
      quality: 'approximate',
    });
  });
  it('uses surrounding text to disambiguate repeated passages', () => {
    const original = anchor({ quote: 'hello', prefix: 'second ', suffix: ' end', chapterFraction: 0 });
    const text = 'first hello start second hello end';
    const chapters = [chapter('one'), chapter('two', text.length)];
    const result = relocatePassage(original, resolveReadingAnchor(original, 'new', chapters), text, chapters);
    expect(result).toMatchObject({ offset: 25, quality: 'relocated', reason: 'passage' });
  });
  it('retains approximate chapter position when a passage was edited', () => {
    const original = anchor({ quote: 'deleted paragraph' });
    const chapters = [chapter('one'), chapter('two')];
    expect(relocatePassage(original, resolveReadingAnchor(original, 'new', chapters), 'replacement', chapters)).toMatchObject({
      chapterFraction: 0.8,
      quality: 'approximate',
    });
  });
});

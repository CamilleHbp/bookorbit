import { expect, it } from 'vitest';
import type { EpubRevisionManifest, RevisionChapter } from '@bookorbit/types';
import { storyChapterChanges, storyUpdateSafety } from './fanfiction-chapter-changes';
const chapter = (href: string, sourceUrl?: string, textHash = 'same'): RevisionChapter => ({
  href,
  title: href,
  sourceUrl,
  textHash,
  length: 0,
});

it('accepts only an identifiable unchanged prefix, ignoring explicitly generated pages', () => {
  const original: EpubRevisionManifest = {
    version: 1,
    contentHash: '',
    metadataHash: '',
    coverHash: null,
    chapters: [{ ...chapter('title'), generated: true }, chapter('one', 'https://example.org/1'), chapter('two', 'https://example.org/2')],
  };
  const next = { ...original, chapters: [...original.chapters, chapter('three', 'https://example.org/3')] };
  expect(storyUpdateSafety(original, next).safety).toBe('append_only');
  expect(storyUpdateSafety(original, original).safety).toBe('unchanged');
  for (const chapters of [
    original.chapters.slice(0, 2),
    [original.chapters[0], original.chapters[2], original.chapters[1]],
    [original.chapters[0], chapter('one', 'https://example.org/1', 'rewritten'), original.chapters[2]],
    [...original.chapters, chapter('unknown')],
    [...original.chapters, chapter('duplicate', 'https://example.org/1')],
  ])
    expect(storyUpdateSafety(original, { ...original, chapters }).safety).toBe('review_required');
});
it('separates new chapters, edited chapters and metadata from generated pages', () => {
  const previous: EpubRevisionManifest = {
    version: 1,
    contentHash: '',
    coverHash: null,
    metadataHash: 'old',
    chapters: [chapter('one', 'https://example.org/1')],
  };
  const next = {
    ...previous,
    metadataHash: 'new',
    chapters: [chapter('title'), chapter('one', 'https://example.org/1', 'changed'), chapter('two', 'https://example.org/2')],
  };
  expect(storyChapterChanges(previous, next)).toEqual({ added: [{ href: 'two', title: 'two' }], changed: 1, metadataChanged: true });
});

import { expect, it } from 'vitest';
import type { EpubRevisionManifest, RevisionChapter } from '@bookorbit/types';
import { storyChapterChanges } from './fanfiction-chapter-changes';
const chapter = (href: string, sourceUrl?: string, textHash = 'same'): RevisionChapter => ({
  href,
  title: href,
  sourceUrl,
  textHash,
  length: 0,
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

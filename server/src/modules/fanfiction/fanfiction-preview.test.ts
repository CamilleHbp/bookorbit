import { describe, expect, it } from 'vitest';
import { validateFanfictionPreview } from './fanfiction-preview';

const preview = {
  canonicalUrl: 'https://example.org/story/1',
  site: 'example.org',
  title: 'Story',
  authors: ['Writer'],
  description: '',
  chapterCount: 2,
  status: 'In-Progress',
  tags: [],
};
describe('controlled runtime metadata boundary', () => {
  it('returns only the shared preview contract', () => {
    expect(validateFanfictionPreview({ ...preview, configuration: 'private' })).toEqual(preview);
  });
  it.each([
    { canonicalUrl: 'file:///etc/passwd' },
    { canonicalUrl: 'https://reader:secret@example.org/story' },
    { title: 'x'.repeat(501) },
    { authors: ['x'.repeat(501)] },
    { tags: Array(1001).fill('tag') },
    { chapterCount: 0 },
    { chapterCount: 10_001 },
    { description: null },
    { status: {} },
  ])('rejects invalid or unbounded runtime output: %j', (fields) => {
    expect(() => validateFanfictionPreview({ ...preview, ...fields })).toThrow('Invalid FanFicFare story metadata');
  });
});

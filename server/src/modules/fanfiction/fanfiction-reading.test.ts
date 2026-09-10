import { describe, expect, it } from 'vitest';
import { storyReading } from './fanfiction-reading';
describe('story reading status', () => {
  it('distinguishes catching up on an ongoing story from finishing a completed story', () => {
    expect(storyReading(5, 'In-Progress', 5, true).status).toBe('caught_up');
    expect(storyReading(5, 'Completed', 5, true).status).toBe('finished');
    expect(storyReading(6, 'In-Progress', 5, true, 'chapter6.xhtml')).toMatchObject({
      status: 'reading',
      unreadChapters: 1,
      nextChapterHref: 'chapter6.xhtml',
    });
  });
  it('does not invent a chapter count for an unresolved reading position', () => {
    expect(storyReading(10, 'Completed', null, true)).toMatchObject({ status: 'reading', readChapters: null, unreadChapters: null });
    expect(storyReading(10, 'Completed', 0, false)).toMatchObject({ status: 'unread', unreadChapters: 10 });
  });
});

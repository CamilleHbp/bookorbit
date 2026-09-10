import type { FanfictionReading } from '@bookorbit/types';

export function storyReading(total: number, status: string, read: number | null, started: boolean, nextChapterHref?: string): FanfictionReading {
  const completed = read === null ? null : Math.max(0, Math.min(total, read));
  const unread = completed === null ? null : Math.max(0, total - completed);
  return {
    status: !started ? 'unread' : unread === 0 ? (/^completed?$/i.test(status.trim()) ? 'finished' : 'caught_up') : 'reading',
    totalChapters: total,
    readChapters: completed,
    unreadChapters: unread,
    ...(nextChapterHref ? { nextChapterHref } : {}),
  };
}

import type { EpubRevisionManifest, FanfictionChapterChanges, RevisionChapter } from '@bookorbit/types';

import { chapterSourceId } from '../../common/utils/chapter-source-id';

// StoriesOnline replaced opaque chapter IDs with ordinal URLs. Its old URL slugs
// sometimes contain the wrong chapter number, so use only unambiguous EPUB titles.
function chapterIds(previous: EpubRevisionManifest, next: EpubRevisionManifest) {
  const unique = (chapters: RevisionChapter[], pattern: RegExp) => {
    const keyed = new Map<string, string | null>();
    for (const chapter of chapters) {
      if (chapter.generated || !chapter.sourceUrl || !chapter.title.trim()) continue;
      const story = pattern.exec(chapter.sourceUrl)?.[1];
      if (!story) continue;
      const key = story + ':' + chapter.title.trim();
      keyed.set(key, keyed.has(key) ? null : chapter.sourceUrl);
    }
    return keyed;
  };
  const legacy = unique(previous.chapters, /^https:\/\/storiesonline\.net\/s\/(\d+):\d+\/[^/?#]+\/?$/);
  const modern = unique(next.chapters, /^https:\/\/storiesonline\.net\/s\/(\d+)\/[^/?#]+\/\d+\/?$/);
  const aliases = new Map<string, string>();
  for (const [key, url] of modern) {
    const old = legacy.get(key);
    if (url && old) aliases.set(url, old);
  }
  return (chapter: RevisionChapter) => chapterSourceId(aliases.get(chapter.sourceUrl ?? '') ?? chapter.sourceUrl);
}

export function storyChapterChanges(previous: EpubRevisionManifest, next: EpubRevisionManifest): FanfictionChapterChanges {
  const id = chapterIds(previous, next);
  const old = new Map(previous.chapters.filter((c) => !c.generated && c.sourceUrl).map((c) => [id(c), c]));
  const chapters = next.chapters.filter((c) => !c.generated && c.sourceUrl);
  return {
    added: chapters.filter((c) => !old.has(id(c))).map(({ href, title }) => ({ href, title })),
    changed: chapters.filter((c) => {
      const saved = old.get(id(c));
      return saved && saved.textHash !== c.textHash;
    }).length,
    metadataChanged: previous.metadataHash !== next.metadataHash,
  };
}

export function storyUpdateSafety(
  previous: EpubRevisionManifest,
  next: EpubRevisionManifest,
): Pick<FanfictionChapterChanges, 'safety' | 'removed' | 'reordered' | 'inserted'> {
  const id = chapterIds(previous, next);
  const before = previous.chapters.filter((chapter) => !chapter.generated);
  const after = next.chapters.filter((chapter) => !chapter.generated);
  const oldIds = before.map((c) => id(c));
  const newIds = after.map((c) => id(c));
  const oldSet = new Set(oldIds);
  const newSet = new Set(newIds);
  const identifiable =
    before.length > 0 &&
    after.length > 0 &&
    [...before, ...after].every((c) => !!c.sourceUrl && !!c.textHash) &&
    oldSet.size === before.length &&
    newSet.size === after.length;
  const removed = oldIds.filter((id) => id && !newSet.has(id)).length;
  const sharedBefore = oldIds.filter((id) => id && newSet.has(id));
  const sharedAfter = newIds.filter((id) => id && oldSet.has(id));
  const reordered = identifiable && sharedBefore.some((id, i) => id !== sharedAfter[i]);
  const retained = after.filter((_, i) => oldSet.has(newIds[i]));
  const unchanged = identifiable && !removed && !reordered && before.every((chapter, i) => chapter.textHash === retained[i]?.textHash);
  const inserted = identifiable && sharedAfter.length > 0 && newIds.slice(0, newIds.lastIndexOf(sharedAfter.at(-1))).some((id) => !oldSet.has(id));
  return {
    safety: !unchanged ? 'review_required' : inserted ? 'insert_only' : after.length > before.length ? 'append_only' : 'unchanged',
    ...(inserted ? { inserted: true } : {}),
    removed,
    reordered,
  };
}

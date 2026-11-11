import type { EpubRevisionManifest, FanfictionChapterChanges } from '@bookorbit/types';

import { chapterSourceId } from '../../common/utils/chapter-source-id';

export function storyChapterChanges(previous: EpubRevisionManifest, next: EpubRevisionManifest): FanfictionChapterChanges {
  const old = new Map(previous.chapters.filter((c) => !c.generated && c.sourceUrl).map((c) => [chapterSourceId(c.sourceUrl), c]));
  const chapters = next.chapters.filter((c) => !c.generated && c.sourceUrl);
  return {
    added: chapters.filter((c) => !old.has(chapterSourceId(c.sourceUrl))).map(({ href, title }) => ({ href, title })),
    changed: chapters.filter((c) => {
      const saved = old.get(chapterSourceId(c.sourceUrl));
      return saved && saved.textHash !== c.textHash;
    }).length,
    metadataChanged: previous.metadataHash !== next.metadataHash,
  };
}

export function storyUpdateSafety(
  previous: EpubRevisionManifest,
  next: EpubRevisionManifest,
): Pick<FanfictionChapterChanges, 'safety' | 'removed' | 'reordered' | 'inserted'> {
  const before = previous.chapters.filter((chapter) => !chapter.generated);
  const after = next.chapters.filter((chapter) => !chapter.generated);
  const oldIds = before.map((c) => chapterSourceId(c.sourceUrl));
  const newIds = after.map((c) => chapterSourceId(c.sourceUrl));
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
  const unchangedPrefix = before.every((c, i) => oldIds[i] === newIds[i] && c.textHash === after[i]?.textHash);
  return {
    safety: !identifiable || !unchangedPrefix ? 'review_required' : after.length > before.length ? 'append_only' : 'unchanged',
    ...(identifiable && sharedAfter.length > 0 && newIds.slice(0, newIds.lastIndexOf(sharedAfter.at(-1))).some((id) => !oldSet.has(id))
      ? { inserted: true }
      : {}),
    removed,
    reordered,
  };
}

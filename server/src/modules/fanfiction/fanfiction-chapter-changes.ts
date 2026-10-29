import type { EpubRevisionManifest, FanfictionChapterChanges } from '@bookorbit/types';
export function storyChapterChanges(previous: EpubRevisionManifest, next: EpubRevisionManifest): FanfictionChapterChanges {
  const old = new Map(previous.chapters.filter((chapter) => chapter.sourceUrl).map((chapter) => [chapter.sourceUrl!, chapter]));
  const chapters = next.chapters.filter((chapter) => chapter.sourceUrl);
  return {
    added: chapters.filter((chapter) => !old.has(chapter.sourceUrl!)).map(({ href, title }) => ({ href, title })),
    changed: chapters.filter((chapter) => old.has(chapter.sourceUrl!) && old.get(chapter.sourceUrl!)!.textHash !== chapter.textHash).length,
    metadataChanged: previous.metadataHash !== next.metadataHash,
  };
}

export function storyUpdateSafety(
  previous: EpubRevisionManifest,
  next: EpubRevisionManifest,
): Pick<FanfictionChapterChanges, 'safety' | 'removed' | 'reordered'> {
  const before = previous.chapters.filter((chapter) => !chapter.generated);
  const after = next.chapters.filter((chapter) => !chapter.generated);
  const oldIds = before.map((chapter) => chapter.sourceUrl);
  const newIds = after.map((chapter) => chapter.sourceUrl);
  const identifiable =
    before.length > 0 &&
    after.length > 0 &&
    [...before, ...after].every((chapter) => !!chapter.sourceUrl && !!chapter.textHash) &&
    new Set(oldIds).size === before.length &&
    new Set(newIds).size === after.length;
  const nextIds = new Set(newIds);
  const removed = oldIds.filter((id) => !nextIds.has(id)).length;
  const reordered = before.some((chapter, index) => newIds[index] !== chapter.sourceUrl);
  const changed = before.some((chapter, index) => after[index]?.textHash !== chapter.textHash);
  return {
    safety: !identifiable || removed > 0 || reordered || changed ? 'review_required' : after.length > before.length ? 'append_only' : 'unchanged',
    removed,
    reordered,
  };
}

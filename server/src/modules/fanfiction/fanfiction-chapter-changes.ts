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

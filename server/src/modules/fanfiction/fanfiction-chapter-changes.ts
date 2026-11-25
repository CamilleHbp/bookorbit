import { createHash } from 'node:crypto';
import type {
  FanfictionChapterConflict,
  EpubRevisionManifest,
  FanfictionChapterChanges,
  FanfictionChapterDifference,
  RevisionChapter,
} from '@bookorbit/types';

import { chapterSourceId } from '../../common/utils/chapter-source-id';

const comparisonHash = (chapter: RevisionChapter) => chapter.comparisonHash ?? chapter.textHash;

function chapterIds(previous: EpubRevisionManifest, next: EpubRevisionManifest) {
  const before = previous.chapters.filter((c) => !c.generated && c.sourceUrl);
  const after = next.chapters.filter((c) => !c.generated && c.sourceUrl);
  const aliases = new Map<RevisionChapter, string>();
  const used = new Set<RevisionChapter>();
  const existing = new Set(before.map((c) => chapterSourceId(c.sourceUrl)));
  const incoming = new Set(after.map((c) => chapterSourceId(c.sourceUrl)));
  const unmatchedBefore = before.filter((c) => !incoming.has(chapterSourceId(c.sourceUrl)));
  const unmatchedAfter = after.filter((c) => !existing.has(chapterSourceId(c.sourceUrl)));
  type Key = (c: RevisionChapter) => string | undefined;
  const unique = (chapters: RevisionChapter[], key: Key) => {
    const result = new Map<string, RevisionChapter | null>();
    for (const chapter of chapters) {
      if (used.has(chapter)) continue;
      const value = key(chapter);
      if (value) result.set(value, result.has(value) ? null : chapter);
    }
    return result;
  };
  function pair(oldKey: Key, newKey: Key) {
    const old = unique(unmatchedBefore, oldKey);
    for (const [key, chapter] of unique(unmatchedAfter, newKey)) {
      const saved = old.get(key);
      if (!saved || !chapter) continue;
      aliases.set(chapter, chapterSourceId(saved.sourceUrl)!);
      used.add(saved);
      used.add(chapter);
    }
  }
  // The caller verifies story identity first. A unique body can survive both
  // a URL migration and a renamed heading. Never use position to infer identity.
  const bodyKey: Key = (c) => {
    if (!c.bodyHash || !c.length || !URL.canParse(c.sourceUrl!)) return undefined;
    const url = new URL(c.sourceUrl!);
    const namespace = url.hostname === 'storiesonline.net' ? url.pathname.match(/^\/([sn]\/\d+)/)?.[1] : '';
    return [url.hostname, namespace, c.bodyHash].join(':');
  };
  pair(bodyKey, bodyKey);
  const titled =
    (pattern: RegExp): Key =>
    (c) => {
      const story = pattern.exec(c.sourceUrl!)?.[1];
      return story && c.title.trim() ? story + ':' + c.title.trim() : undefined;
    };
  pair(titled(/^https:\/\/storiesonline\.net\/([sn]\/\d+):\d+\/[^/?#]+\/?$/), titled(/^https:\/\/storiesonline\.net\/([sn]\/\d+)\/[^/?#]+\/\d+\/?$/));
  return (chapter: RevisionChapter) => aliases.get(chapter) ?? chapterSourceId(chapter.sourceUrl);
}

export function storyChapterChanges(previous: EpubRevisionManifest, next: EpubRevisionManifest): FanfictionChapterChanges {
  const id = chapterIds(previous, next);
  const old = new Map(previous.chapters.filter((c) => !c.generated && c.sourceUrl).map((c) => [id(c), c]));
  const chapters = next.chapters.filter((c) => !c.generated && c.sourceUrl);
  return {
    added: chapters.filter((c) => !old.has(id(c))).map(({ href, title }) => ({ href, title })),
    changed: chapters.filter((c) => {
      const saved = old.get(id(c));
      return saved && comparisonHash(saved) !== comparisonHash(c);
    }).length,
    metadataChanged: previous.metadataHash !== next.metadataHash,
  };
}

export function storyUpdateSafety(
  previous: EpubRevisionManifest,
  next: EpubRevisionManifest,
): Pick<FanfictionChapterChanges, 'safety' | 'removed' | 'reordered' | 'inserted' | 'unmatched'> {
  const id = chapterIds(previous, next);
  const before = previous.chapters.filter((chapter) => !chapter.generated);
  const after = next.chapters.filter((chapter) => !chapter.generated);
  const oldIds = before.map((c) => id(c));
  const newIds = after.map((c) => id(c));
  if (
    before.length &&
    before.length === after.length &&
    (!oldIds.every(Boolean) || !newIds.every(Boolean)) &&
    before.every(
      (c, i) => comparisonHash(c) && comparisonHash(c) === comparisonHash(after[i]) && (!oldIds[i] || !newIds[i] || oldIds[i] === newIds[i]),
    )
  ) {
    return { safety: 'unchanged', removed: 0, reordered: false };
  }
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
  const unchanged = identifiable && !removed && !reordered && before.every((chapter, i) => comparisonHash(chapter) === comparisonHash(retained[i]));
  const inserted = identifiable && sharedAfter.length > 0 && newIds.slice(0, newIds.lastIndexOf(sharedAfter.at(-1))).some((id) => !oldSet.has(id));
  return {
    safety:
      !identifiable || removed || reordered
        ? 'review_required'
        : !unchanged
          ? 'content_only'
          : inserted
            ? 'insert_only'
            : after.length > before.length
              ? 'append_only'
              : 'unchanged',
    ...(removed &&
    before.some((c) => /^https:\/\/storiesonline\.net\/[sn]\/\d+:/.test(c.sourceUrl ?? '')) &&
    after.some((c, i) => !oldSet.has(newIds[i]) && /^https:\/\/storiesonline\.net\/[sn]\/\d+\/[^/]+\/\d+/.test(c.sourceUrl ?? ''))
      ? { unmatched: true }
      : {}),
    ...(inserted ? { inserted: true } : {}),
    removed,
    reordered,
  };
}

export function chapterConflicts(previous: EpubRevisionManifest, next: EpubRevisionManifest, reviewed: FanfictionChapterConflict[] = []) {
  const id = chapterIds(previous, next);
  const before = previous.chapters.filter((c) => !c.generated);
  const after = next.chapters.filter((c) => !c.generated);
  const unique = (chapters: RevisionChapter[]) => {
    const result = new Map<string, RevisionChapter | null>();
    for (const chapter of chapters) {
      const key = id(chapter);
      if (key) result.set(key, result.has(key) ? null : chapter);
    }
    return result;
  };
  const saved = unique(before);
  const decisions = new Map(reviewed.map((c) => [c.key, c.decision]));
  const conflicts: FanfictionChapterConflict[] = [];
  for (const [identity, incoming] of unique(after)) {
    const old = saved.get(identity);
    if (!old || !incoming || !incoming.sourceUrl) continue;
    const oldHash = old.bodyHash ?? comparisonHash(old),
      newHash = incoming.bodyHash ?? comparisonHash(incoming);
    const savedLength = old.bodyLength ?? old.length,
      websiteLength = incoming.bodyLength ?? incoming.length;
    if ((oldHash === newHash && old.illustrationHash === incoming.illustrationHash) || websiteLength > savedLength) continue;
    const key = createHash('sha256')
      .update(JSON.stringify([identity, oldHash, newHash, old.illustrationHash, incoming.illustrationHash]))
      .digest('hex');
    conflicts.push({
      key,
      title: incoming.title,
      sourceUrl: incoming.sourceUrl,
      savedHref: old.href,
      websiteHref: incoming.href,
      savedLength,
      websiteLength,
      decision: decisions.get(key),
    });
  }
  return conflicts;
}

export function changedTextExcerpts(saved: string, website: string) {
  let start = 0;
  while (start < saved.length && start < website.length && saved[start] === website[start]) start++;
  const excerpt = (s: string) => (start > 35 ? '…' : '') + s.slice(Math.max(0, start - 35), start + 90) + (s.length > start + 90 ? '…' : '');
  return { savedExcerpt: excerpt(saved), websiteExcerpt: excerpt(website) };
}

export async function chapterDifferences(
  previous: EpubRevisionManifest,
  next: EpubRevisionManifest,
  savedText: (href: string) => Promise<string>,
  websiteText: (href: string) => Promise<string>,
) {
  const id = chapterIds(previous, next);
  const before = previous.chapters.filter((c) => !c.generated);
  const after = next.chapters.filter((c) => !c.generated);
  const old = new Map(before.map((c, i) => [id(c), i]));
  const incoming = new Set(after.map(id));
  const retained = before.filter((c) => incoming.has(id(c)));
  let shared = 0;
  const differences: FanfictionChapterDifference[] = [];
  for (const [i, c] of after.entries()) {
    const index = id(c) ? old.get(id(c)) : undefined;
    const website = { position: i + 1, title: c.title };
    if (index === undefined) {
      differences.push({ website });
      continue;
    }
    const saved = before[index];
    const expected = retained[shared++];
    const moved = !expected || id(expected) !== id(c);
    if (!moved && comparisonHash(saved) === comparisonHash(c)) continue;
    const row: FanfictionChapterDifference = { saved: { position: index + 1, title: saved.title }, website };
    if (comparisonHash(saved) !== comparisonHash(c) && differences.length < 100) {
      const [a, b] = await Promise.all([savedText(saved.href), websiteText(c.href)]);
      const excerpts = changedTextExcerpts(a, b);
      row.saved!.excerpt = excerpts.savedExcerpt;
      row.website!.excerpt = excerpts.websiteExcerpt;
    }
    differences.push(row);
  }
  for (const [i, c] of before.entries()) if (!id(c) || !incoming.has(id(c))) differences.push({ saved: { position: i + 1, title: c.title } });
  return differences;
}

export function differentStory(
  saved: { title: string; authors: string[] },
  website: { title: string; authors: string[] },
  previous: EpubRevisionManifest,
  next: EpubRevisionManifest,
) {
  const normalize = (s: string) => s.trim().normalize('NFKC').toLowerCase();
  if (!saved.title || !website.title || normalize(saved.title) === normalize(website.title)) return false;
  const authors = new Set(saved.authors.map(normalize).filter(Boolean));
  if (!authors.size || !website.authors.some((a) => normalize(a)) || website.authors.some((a) => authors.has(normalize(a)))) return false;
  const hashes = (m: EpubRevisionManifest) =>
    m.chapters.filter((c) => !c.generated && c.length > 0).flatMap((c) => [comparisonHash(c), ...(c.bodyHash ? [c.bodyHash] : [])]);
  const old = new Set(hashes(previous)),
    incoming = hashes(next);
  return old.size > 0 && incoming.length > 0 && !incoming.some((h) => old.has(h));
}

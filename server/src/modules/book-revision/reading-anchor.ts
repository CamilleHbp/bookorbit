import type { ReadingAnchor, ResolvedReadingAnchor, RevisionChapter } from '@bookorbit/types';
import { BadRequestException } from '@nestjs/common';
import { ANCHOR_CONTEXT_LIMIT, ANCHOR_QUOTE_LIMIT, scalarLength } from './anchor-text';

const MATCH_FIELDS = ['sourceUrl', 'textHash', 'href', 'title'] as const;
type ChapterLookup = Map<(typeof MATCH_FIELDS)[number], Map<string, number[]>>;

function indexChapters(chapters: RevisionChapter[]): ChapterLookup {
  const lookup: ChapterLookup = new Map();
  for (const field of MATCH_FIELDS) {
    const values = new Map<string, number[]>();
    for (let index = 0; index < chapters.length; index++) {
      const value = chapters[index][field];
      if (!value) continue;
      const matches = values.get(value);
      if (matches) matches.push(index);
      else values.set(value, [index]);
    }
    lookup.set(field, values);
  }
  return lookup;
}

export function clampFraction(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function chapterMatch(source: Partial<RevisionChapter>, chapters: RevisionChapter[], hint: number, lookup: ChapterLookup): number {
  for (const field of MATCH_FIELDS) {
    if (!source[field]) continue;
    const candidates = lookup.get(field)?.get(source[field]!) ?? [];
    if (field === 'title' && candidates.length !== 1) continue;
    const matches = candidates.filter((index) => {
      const chapter = chapters[index];
      return !((field === 'href' || field === 'title') && source.sourceUrl && chapter.sourceUrl && source.sourceUrl !== chapter.sourceUrl);
    });
    if (field === 'title' && matches.length !== 1) continue;
    if (matches.length) return matches.reduce((a, b) => (Math.abs(a - hint) <= Math.abs(b - hint) ? a : b));
  }
  return -1;
}

function bookFraction(chapters: RevisionChapter[], index: number, fraction: number): number {
  const total = chapters.reduce((sum, chapter) => sum + Math.max(1, chapter.length), 0);
  const before = chapters.slice(0, index).reduce((sum, chapter) => sum + Math.max(1, chapter.length), 0);
  return clampFraction((before + Math.max(1, chapters[index]?.length ?? 1) * fraction) / Math.max(1, total));
}

export function resolveReadingAnchor(
  anchor: ReadingAnchor,
  revision: string,
  target: RevisionChapter[],
  source: RevisionChapter[] = [],
): ResolvedReadingAnchor {
  if (!target.length) throw new BadRequestException('Target revision has no readable chapters');
  const chapterIndex = Number.isFinite(anchor.chapterIndex) ? Math.max(0, Math.floor(anchor.chapterIndex)) : 0;
  anchor = { ...anchor, chapterIndex };
  const lookup = indexChapters(target);
  let index = chapterMatch(
    {
      href: anchor.chapterHref,
      title: anchor.chapterTitle,
      sourceUrl: anchor.chapterSourceUrl,
      textHash: anchor.chapterTextHash,
    },
    target,
    anchor.chapterIndex,
    lookup,
  );
  let fraction = clampFraction(anchor.chapterFraction);
  let reason: ResolvedReadingAnchor['reason'] = 'chapter';
  if (index < 0 && source.length) {
    // A deleted chapter maps to a surviving neighbor, never to the same ordinal's unrelated text.
    for (let distance = 1; distance < source.length; distance++) {
      for (const oldIndex of [anchor.chapterIndex - distance, anchor.chapterIndex + distance]) {
        const chapter = source[oldIndex];
        if (!chapter) continue;
        index = chapterMatch(chapter, target, oldIndex, lookup);
        if (index >= 0) {
          fraction = oldIndex < anchor.chapterIndex ? 1 : 0;
          break;
        }
      }
      if (index >= 0) break;
    }
    reason = 'surviving_boundary';
  }
  if (index < 0) {
    reason = 'proportional';
    const total = target.reduce((sum, chapter) => sum + Math.max(1, chapter.length), 0);
    let remaining = clampFraction(anchor.bookFraction) * total;
    index = Math.max(0, target.length - 1);
    fraction = 1;
    for (let i = 0; i < target.length; i++) {
      const length = Math.max(1, target[i].length);
      if (remaining <= length) {
        index = i;
        fraction = remaining / length;
        break;
      }
      remaining -= length;
    }
  }
  return {
    revision,
    chapterIndex: index,
    chapterFraction: fraction,
    bookFraction: bookFraction(target, index, fraction),
    quality: 'approximate',
    reason,
  };
}

export function relocatePassage(
  anchor: ReadingAnchor,
  resolution: ResolvedReadingAnchor,
  normalizedText: string,
  chapters: RevisionChapter[],
): ResolvedReadingAnchor {
  if (!anchor.quote || normalizedText.length > 4_000_000) return resolution;
  const needle = anchor.quote;
  if (
    scalarLength(needle) > ANCHOR_QUOTE_LIMIT ||
    scalarLength(anchor.prefix ?? '') > ANCHOR_CONTEXT_LIMIT ||
    scalarLength(anchor.suffix ?? '') > ANCHOR_CONTEXT_LIMIT
  )
    return resolution;
  const textLength = scalarLength(normalizedText);
  const hint = Math.round(textLength * resolution.chapterFraction);
  const prefix = anchor.prefix ?? '';
  const suffix = anchor.suffix ?? '';
  let best = -1;
  let bestScore = -Infinity;
  let matches = 0;
  let bestContext = 0;
  let start = normalizedText.indexOf(needle);
  let previousStart = 0;
  let scalarOffset = 0;
  for (; start >= 0 && matches < 200; matches++) {
    scalarOffset += scalarLength(normalizedText.slice(previousStart, start));
    previousStart = start;
    const before = normalizedText.slice(Math.max(0, start - prefix.length), start);
    const after = normalizedText.slice(start + needle.length, start + needle.length + suffix.length);
    const contextScore = (prefix && before === prefix ? 2 : 0) + (suffix && after === suffix ? 2 : 0);
    const score = contextScore - Math.abs(scalarOffset - hint) / Math.max(1, textLength);
    if (score > bestScore) {
      best = scalarOffset;
      bestScore = score;
      bestContext = contextScore;
    }
    start = normalizedText.indexOf(needle, start + 1);
  }
  if (best < 0 || start >= 0 || (matches > 1 && bestContext === 0)) return resolution;
  const fraction = clampFraction(best / Math.max(1, textLength));
  return {
    ...resolution,
    offset: best,
    chapterFraction: fraction,
    bookFraction: bookFraction(chapters, resolution.chapterIndex, fraction),
    quality: 'relocated',
    reason: 'passage',
  };
}

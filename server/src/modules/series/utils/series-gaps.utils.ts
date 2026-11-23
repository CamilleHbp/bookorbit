import { MAX_SERIES_TOTAL_BOOKS, normalizeSeriesTotalBooks } from '../../../common/utils/series-total-books.utils';

export function wholeSeriesVolume(index: string | null): number | null {
  return index !== null && /^\d+(?:\.0+)?$/.test(index) ? Number(index) : null;
}

type Coverage = readonly (readonly number[] | undefined)[];

function inspectVolumes(
  indices: (string | null)[],
  bookCount: number,
  expectedBookCount: number | null,
  coverage: Coverage,
): { present: Set<number>; from: number; to: number } | undefined {
  const present = new Set<number>();
  let min = Infinity;
  let max = -Infinity;
  let positionedBooks = 0;

  function remember(volume: number) {
    present.add(volume);
    min = Math.min(min, volume);
    max = Math.max(max, volume);
  }

  for (const [position, index] of indices.entries()) {
    const whole = wholeSeriesVolume(index);
    const covered = coverage[position] ?? [];
    if (whole !== null) remember(whole);
    for (const volume of covered) remember(volume);
    if (whole !== null || covered.length > 0) positionedBooks++;
  }

  if (present.size === 0 || min < 1 || max > MAX_SERIES_TOTAL_BOOKS) return undefined;

  // A total can name missing endpoints only when all held books have positions and fit in it.
  const expected = normalizeSeriesTotalBooks(expectedBookCount);
  if (expected !== undefined && positionedBooks === bookCount && max <= expected) {
    return { present, from: 1, to: expected };
  }
  return { present, from: min, to: max };
}

export function computeSeriesGaps(
  indices: (string | null)[],
  bookCount: number,
  expectedBookCount: number | null,
  coverage: Coverage = [],
): number[] {
  const volumes = inspectVolumes(indices, bookCount, expectedBookCount, coverage);
  if (!volumes) return [];
  const gaps: number[] = [];
  for (let volume = volumes.from; volume <= volumes.to; volume++) {
    if (!volumes.present.has(volume)) gaps.push(volume);
  }
  return gaps;
}

export function resolveLadderRange(
  indices: (string | null)[],
  bookCount: number,
  expectedBookCount: number | null,
  coverage: Coverage = [],
): { from: number; to: number } | undefined {
  const volumes = inspectVolumes(indices, bookCount, expectedBookCount, coverage);
  return volumes && { from: volumes.from, to: volumes.to };
}

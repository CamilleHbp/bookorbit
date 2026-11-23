import type { SeriesIndex, SeriesVolumeSlot, SeriesVolumeStatus } from '@bookorbit/types';
import { compareSeriesIndices, parseSeriesIndex, SERIES_VOLUME_SLOT_LIMIT } from '@bookorbit/types';

import type { SeriesMemberRow, SeriesVolumeMember } from '../series.repository';
import { computeSeriesGaps, resolveLadderRange, wholeSeriesVolume } from './series-gaps.utils';

export type SeriesVolumeCounts = {
  ownedVolumeCount: number;
  readVolumeCount: number;
  readingVolumeCount: number;
};

export type SeriesLadder = {
  volumes: SeriesVolumeSlot[];
  truncated: boolean;
  gaps: number[];
  next: { bookId: number; index: SeriesIndex | null; title: string | null } | null;
  /** Logical volumes across the whole series, not just the capped slots; null when the members could not all be read. */
  counts: SeriesVolumeCounts | null;
};

const STATUS_RANK: Record<SeriesVolumeStatus, number> = { read: 3, reading: 2, unread: 1, missing: 0 };

function memberStatus(status: string | null): SeriesVolumeStatus {
  if (status === 'read') return 'read';
  if (status === 'reading') return 'reading';
  return 'unread';
}

function groupSeriesMembers<T extends SeriesVolumeMember>(params: {
  members: T[];
  bookCount: number;
  expectedBookCount: number | null;
}): {
  gaps: number[];
  range: { from: number; to: number } | undefined;
  byIndex: Map<number, T>;
  unnumbered: T[];
} {
  const { members, bookCount, expectedBookCount } = params;
  const indices = members.map((member) => member.seriesIndex);
  const coverage = members.map((member) => member.coveredVolumes);
  const gaps = computeSeriesGaps(indices, bookCount, expectedBookCount, coverage);
  const range = resolveLadderRange(indices, bookCount, expectedBookCount, coverage);
  const byIndex = new Map<number, T>();
  const unnumbered: T[] = [];

  for (const member of members) {
    const index = wholeSeriesVolume(member.seriesIndex);
    const positions = new Set(member.coveredVolumes);
    if (index !== null) positions.add(index);
    if (!range || positions.size === 0) {
      unnumbered.push(member);
      continue;
    }
    const rank = STATUS_RANK[memberStatus(member.status)];
    for (const position of positions) {
      const held = byIndex.get(position);
      const heldRank = held ? STATUS_RANK[memberStatus(held.status)] : -1;
      if (rank > heldRank || (rank === heldRank && position === index && wholeSeriesVolume(held?.seriesIndex ?? null) !== position)) {
        byIndex.set(position, member);
      }
    }
  }

  return { gaps, range, byIndex, unnumbered };
}

function tallyVolumes(grouped: { byIndex: ReadonlyMap<number, SeriesVolumeMember>; unnumbered: readonly SeriesVolumeMember[] }): SeriesVolumeCounts {
  const statuses = [...grouped.byIndex.values(), ...grouped.unnumbered].map((member) => memberStatus(member.status));

  return {
    ownedVolumeCount: statuses.length,
    readVolumeCount: statuses.filter((status) => status === 'read').length,
    readingVolumeCount: statuses.filter((status) => status === 'reading').length,
  };
}

/**
 * Counts logical volumes rather than book records. Numbered copies share one volume and keep the
 * furthest reading state, while books without a usable whole-numbered position stay independent.
 */
export function countSeriesVolumes(params: {
  members: SeriesVolumeMember[];
  bookCount: number;
  expectedBookCount: number | null;
}): SeriesVolumeCounts {
  return tallyVolumes(groupSeriesMembers(params));
}

/**
 * The volume ladder lists whole-volume slots and owned dotted positions in series order.
 * Books without a valid position come last.
 *
 * Two books can sit on the same number - the same volume held in two libraries, or in two formats -
 * and the slot then shows the furthest the user got with either, because that is what "have I read
 * volume four" means to the person asking.
 */
export function buildVolumeLadder(params: {
  members: SeriesMemberRow[];
  truncated: boolean;
  bookCount: number;
  expectedBookCount: number | null;
}): SeriesLadder {
  const { members, bookCount, expectedBookCount } = params;

  if (members.length === 0) {
    return { volumes: [], truncated: params.truncated, gaps: [], next: null, counts: null };
  }

  // A series we could not read in full can still be counted, but naming a volume missing needs
  // every sibling in hand, so a truncated one draws no ladder rather than a wrong one.
  if (params.truncated) {
    return { volumes: [], truncated: true, gaps: [], next: firstOpenMember(members), counts: null };
  }

  const grouped = groupSeriesMembers({ members, bookCount, expectedBookCount });
  const { gaps, range, byIndex, unnumbered } = grouped;

  const volumes: SeriesVolumeSlot[] = [];
  const wholeSlotCount = range ? range.to - range.from + 1 : 0;

  if (range) {
    const last = Math.min(range.to, range.from + SERIES_VOLUME_SLOT_LIMIT - 1);
    for (let i = range.from; i <= last; i++) {
      const member = byIndex.get(i);
      volumes.push(
        member
          ? { index: i, bookId: member.bookId, title: member.title, status: memberStatus(member.status) }
          : { index: i, bookId: null, title: null, status: 'missing' },
      );
    }
  }

  for (const member of unnumbered) {
    volumes.push({
      index: wholeSeriesVolume(member.seriesIndex) === null ? parseSeriesIndex(member.seriesIndex) : null,
      bookId: member.bookId,
      title: member.title,
      status: memberStatus(member.status),
    });
  }

  if (unnumbered.length > 0) {
    volumes.sort((a, b) => {
      if (a.index === null) return b.index === null ? 0 : 1;
      if (b.index === null) return -1;
      return compareSeriesIndices(String(a.index), String(b.index));
    });
  }

  const visible = volumes.slice(0, SERIES_VOLUME_SLOT_LIMIT);
  return {
    volumes: visible,
    truncated: wholeSlotCount + unnumbered.length > SERIES_VOLUME_SLOT_LIMIT,
    gaps,
    next: nextFromSlots(visible, members),
    counts: tallyVolumes(grouped),
  };
}

function displaySeriesIndex(index: SeriesIndex | null): SeriesIndex | null {
  return index?.replace(/\.0+$/, '') ?? null;
}

// Prefer the book in progress, then the earliest unread position.
function nextFromSlots(volumes: SeriesVolumeSlot[], members: SeriesMemberRow[]): SeriesLadder['next'] {
  const slot = volumes.find((s) => s.status === 'reading' && s.bookId !== null) ?? volumes.find((s) => s.status === 'unread' && s.bookId !== null);
  if (slot?.bookId != null) {
    const member = members.find((m) => m.bookId === slot.bookId);
    return { bookId: slot.bookId, index: displaySeriesIndex(member?.seriesIndex ?? null), title: slot.title };
  }
  // Nothing open inside the drawn ladder; a capped one may still have something past its end.
  return firstOpenMember(members);
}

function firstOpenMember(members: SeriesMemberRow[]): SeriesLadder['next'] {
  const open = members.find((m) => m.status === 'reading') ?? members.find((m) => m.status !== 'read');
  return open ? { bookId: open.bookId, index: displaySeriesIndex(open.seriesIndex), title: open.title } : null;
}

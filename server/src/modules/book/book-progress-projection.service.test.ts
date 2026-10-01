import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import type { ReadingAnchor } from '@bookorbit/types';
import type { DatabaseTransaction } from '../../db/transaction';
import { ReadingAttemptService } from '../user-book-status/reading-attempt.service';
import { BookProgressProjectionService } from './book-progress-projection.service';

describe('BookProgressProjectionService', () => {
  it('clears the old narration location when text reading moves to another passage', async () => {
    const recordActivity = vi.fn();
    const module = await Test.createTestingModule({
      providers: [BookProgressProjectionService, { provide: ReadingAttemptService, useValue: { recordActivity } }],
    }).compile();
    const saved = {
      cfi: 'epubcfi(/6/2)',
      positionSeconds: 12,
      mediaOverlayFragment: 'chapter.xhtml#sentence-4',
      mediaOverlaySectionIndex: 0,
    };
    const tx = {
      insert: () => ({ values: () => ({ onConflictDoUpdate: ({ set }: { set: object }) => Object.assign(saved, set) }) }),
      delete: () => ({ where: vi.fn() }),
    } as unknown as DatabaseTransaction;
    const anchor: ReadingAnchor = {
      schemaVersion: 1,
      bookId: 3,
      bookFileId: 9,
      revision: `sha256:${'a'.repeat(64)}`,
      chapterIndex: 1,
      chapterFraction: 0.5,
      bookFraction: 0.3,
      quote: 'The next passage',
      nativeLocator: { kind: 'cfi', value: 'epubcfi(/6/4)' },
      event: { id: 'reading-event', deviceId: 'reader', deviceSequence: 1, occurredAt: '2026-10-01T10:00:00.000Z', resetGeneration: 0 },
    };
    await module.get(BookProgressProjectionService).record(tx, {
      userId: 7,
      bookId: 3,
      bookFileId: 9,
      anchor,
      previous: null,
      percentage: 30,
      nativeCompatible: true,
      finishThreshold: 95,
    });
    expect(saved).toMatchObject({
      cfi: 'epubcfi(/6/4)',
      positionSeconds: null,
      mediaOverlayFragment: null,
      mediaOverlaySectionIndex: null,
    });
    await module.close();
  });
});

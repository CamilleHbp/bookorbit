import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { ReadingAnchor } from '@bookorbit/types';
import type { DatabaseTransaction } from '../../db/transaction';
import { koreaderProgressResets, readingProgress } from '../../db/schema';
import { ReadingAttemptService } from '../user-book-status/reading-attempt.service';

@Injectable()
export class BookProgressProjectionService {
  constructor(private readonly attempts: ReadingAttemptService) {}

  async record(
    tx: DatabaseTransaction,
    input: {
      userId: number;
      bookId: number;
      bookFileId: number;
      anchor: ReadingAnchor;
      previous: ReadingAnchor | null;
      percentage: number;
      nativeCompatible: boolean;
      finishThreshold: number;
    },
  ): Promise<void> {
    const { anchor, previous, userId, bookId, bookFileId } = input;
    const native = input.nativeCompatible ? anchor.nativeLocator : undefined;
    const progress = {
      percentage: input.percentage,
      cfi: native?.kind === 'cfi' && native.value.length <= 2000 ? native.value : null,
      koreaderProgress: native?.kind === 'xpointer' ? native.value : null,
      pageNumber: null,
      positionSeconds: null,
      koboLocationSource: null,
      koboLocationType: null,
      koboLocationValue: null,
      koboContentSourceProgressPercent: null,
      lastReadAt: new Date(anchor.event!.occurredAt),
      updatedAt: new Date(),
    };
    await tx
      .insert(readingProgress)
      .values({ userId, bookFileId, ...progress })
      .onConflictDoUpdate({ target: [readingProgress.userId, readingProgress.bookFileId], set: progress });
    await tx.delete(koreaderProgressResets).where(and(eq(koreaderProgressResets.userId, userId), eq(koreaderProgressResets.bookFileId, bookFileId)));
    await this.attempts.recordActivity(
      {
        userId,
        bookId,
        occurredOn: anchor.event!.occurredAt.slice(0, 10),
        origin: anchor.nativeLocator?.kind === 'xpointer' ? 'koreader' : 'bookorbit',
        // A projection onto different content cannot establish completion of that content.
        progress: input.nativeCompatible ? input.percentage : Math.min(input.percentage, Math.max(0, input.finishThreshold - 0.01)),
        finishThreshold: input.finishThreshold,
        strongRereadEvidence: previous?.revision === anchor.revision && previous.bookFraction - anchor.bookFraction >= 0.1,
        meaningfulActivity: true,
        preserveManualStatus: true,
      },
      tx,
    );
  }
}

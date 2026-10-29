import { Injectable, Logger } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { PositionConverterService } from '../position-converter/position-converter.service';
import { AnnotationPositionRepository } from './annotation-position.repository';
import type { AnnotationWithCfi } from './annotation.repository';
import { AnnotationSyncService } from './annotation-sync.service';

const EVENT = 'annotation.cfi_backfill';

/**
 * Lazily converts device xpointer positions to CFIs so the web reader can draw
 * them. Runs bounded batches on reader load; rows whose conversion failed are
 * retried after a converter upgrade or a file revision change.
 */
@Injectable()
export class AnnotationConversionService {
  private readonly logger = new Logger(AnnotationConversionService.name);

  constructor(
    private readonly positionRepo: AnnotationPositionRepository,
    private readonly positionConverter: PositionConverterService,
    private readonly annotationSync: AnnotationSyncService,
  ) {}

  async projectReaderPositions(rows: AnnotationWithCfi[], bookFileId: number): Promise<AnnotationWithCfi[]> {
    const projected: AnnotationWithCfi[] = [];
    for (const row of rows) {
      if (!row.cfi || !row.text) {
        projected.push({ ...row, cfi: null });
        continue;
      }
      if (row.cfiFileId === bookFileId) {
        projected.push(row);
        continue;
      }
      const range = await this.positionConverter.cfiToXpointer({ bookFileId, cfi: row.cfi, text: row.text });
      const target =
        range.status !== 'failed' && range.pos0 && range.pos1
          ? await this.positionConverter.xpointerToCfi({ bookFileId, pos0: range.pos0, pos1: range.pos1, text: row.text })
          : null;
      projected.push({
        ...row,
        cfi: target?.cfi ?? null,
        cfiStatus: target?.cfi ? (range.status === 'repaired' ? 'repaired' : target.status) : 'failed',
        cfiExtras: { chapterIndex: target?.chapterIndex ?? range.chapterIndex ?? null },
        jumpFileId: target?.cfi ? bookFileId : row.jumpFileId,
      });
    }
    return projected;
  }

  async ensureCfiPositionsForBook(userId: number, bookId: number, limit = 25): Promise<number> {
    const startedAtMs = Date.now();
    try {
      const candidates = await this.findCandidates(userId, bookId, limit);
      if (candidates.length === 0) return 0;

      let converted = 0;
      let failed = 0;
      for (const candidate of candidates) {
        const outcome = await this.positionConverter.xpointerToCfi({
          bookFileId: candidate.bookFileId,
          pos0: candidate.pos0,
          pos1: candidate.pos1,
          text: candidate.text || null,
        });
        const chapterIndex = outcome.chapterIndex ?? null;
        const identity = { revisionId: candidate.revisionId, sha256: candidate.sha256 };
        if (outcome.status === 'failed' || !outcome.cfi) {
          failed += 1;
          await this.annotationSync.upsertGeneratedPosition({
            annotationId: candidate.annotationId,
            userId,
            bookFileId: candidate.bookFileId,
            format: 'cfi',
            pos0: null,
            pos1: null,
            status: 'failed',
            converterVersion: this.positionConverter.version,
            extras: { ...identity, chapterIndex, reason: outcome.reason },
          });
        } else {
          converted += 1;
          await this.annotationSync.upsertGeneratedPosition({
            annotationId: candidate.annotationId,
            userId,
            bookFileId: candidate.bookFileId,
            format: 'cfi',
            pos0: outcome.cfi,
            pos1: null,
            status: outcome.status,
            converterVersion: this.positionConverter.version,
            extras: { ...identity, chapterIndex },
          });
        }
      }

      this.logger.log(
        `[${EVENT}] [end] userId=${userId} bookId=${bookId} durationMs=${Date.now() - startedAtMs} converted=${converted} failed=${failed} - cfi backfill completed`,
      );
      return converted;
    } catch (error) {
      const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
      this.logger.warn(
        `[${EVENT}] [fail] userId=${userId} bookId=${bookId} durationMs=${Date.now() - startedAtMs} errorClass=${errorClass} error="${sanitizeLogValue(error instanceof Error ? error.message : 'unknown error')}" - cfi backfill failed`,
      );
      return 0;
    }
  }

  private async findCandidates(
    userId: number,
    bookId: number,
    limit: number,
  ): Promise<
    { annotationId: number; text: string; pos0: string; pos1: string | null; bookFileId: number; revisionId: string | null; sha256: string | null }[]
  > {
    const candidates = await this.positionRepo.findCfiConversionCandidates(userId, bookId, this.positionConverter.version, limit);
    return candidates.map((row) => ({
      revisionId: row.revisionId,
      sha256: row.sha256,
      annotationId: row.annotationId,
      text: row.text,
      pos0: row.pos0!,
      pos1: row.pos1,
      bookFileId: row.bookFileId!,
    }));
  }
}

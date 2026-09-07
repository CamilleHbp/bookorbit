import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { annotationPositions, annotations, AnnotationPosition, NewAnnotationPosition } from '../../db/schema';
import type { AnnotationPositionFormat } from './annotation.constants';

type Db = NodePgDatabase<typeof schema>;

@Injectable()
export class AnnotationPositionRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async upsert(position: NewAnnotationPosition): Promise<AnnotationPosition> {
    const [row] = await this.db
      .insert(annotationPositions)
      .values(position)
      .onConflictDoUpdate({
        target: [annotationPositions.annotationId, annotationPositions.format],
        set: {
          pos0: sql`excluded.pos0`,
          pos1: sql`excluded.pos1`,
          status: sql`excluded.status`,
          converterVersion: sql`excluded.converter_version`,
          extras: sql`excluded.extras`,
          bookFileId: sql`excluded.book_file_id`,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async findByAnnotationIds(annotationIds: number[]): Promise<AnnotationPosition[]> {
    if (annotationIds.length === 0) return [];
    return this.db.select().from(annotationPositions).where(inArray(annotationPositions.annotationId, annotationIds));
  }

  async findByAnnotationId(annotationId: number, format?: AnnotationPositionFormat): Promise<AnnotationPosition[]> {
    const conditions = [eq(annotationPositions.annotationId, annotationId)];
    if (format) conditions.push(eq(annotationPositions.format, format));
    return this.db
      .select()
      .from(annotationPositions)
      .where(and(...conditions));
  }

  async findCfiConversionCandidates(userId: number, bookId: number, converterVersion: number, limit: number) {
    const batchSize = Number.isFinite(limit) ? Math.min(100, Math.max(0, Math.floor(limit))) : 25;
    if (batchSize === 0) return [];
    const cfi = alias(annotationPositions, 'cfi_position');
    return this.db
      .select({
        annotationId: annotations.id,
        text: annotations.text,
        pos0: annotationPositions.pos0,
        pos1: annotationPositions.pos1,
        bookFileId: annotationPositions.bookFileId,
        status: annotationPositions.status,
      })
      .from(annotations)
      .innerJoin(annotationPositions, and(eq(annotationPositions.annotationId, annotations.id), eq(annotationPositions.format, 'xpointer')))
      .leftJoin(cfi, and(eq(cfi.annotationId, annotations.id), eq(cfi.format, 'cfi')))
      .where(
        and(
          eq(annotations.userId, userId),
          eq(annotations.bookId, bookId),
          eq(annotationPositions.userId, userId),
          isNull(annotations.deletedAt),
          isNotNull(annotationPositions.pos0),
          isNotNull(annotationPositions.bookFileId),
          ne(annotationPositions.status, 'failed'),
          or(isNull(cfi.id), eq(cfi.status, 'pending'), lt(cfi.converterVersion, converterVersion)),
        ),
      )
      .orderBy(asc(annotations.id))
      .limit(batchSize);
  }

  async markPending(annotationId: number, format: AnnotationPositionFormat): Promise<void> {
    await this.db
      .update(annotationPositions)
      .set({ status: 'pending', updatedAt: sql`now()` })
      .where(and(eq(annotationPositions.annotationId, annotationId), eq(annotationPositions.format, format)));
  }
}

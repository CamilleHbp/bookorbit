import { ForbiddenException } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNotNull, ne } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { IncomingLabel } from '@bookorbit/types';
import * as s from '../../db/schema';

// Only retained source evidence is imported. Existing manual labels are not inferred
// to be source-owned, and this operation never changes displayed book metadata.
export async function backfillMatchingSnapshots(db: NodePgDatabase<typeof s>, userId: number, libraryIds: number[], apply: boolean) {
  let cursor: string | undefined;
  let inserted = 0,
    examined = 0;
  while (true) {
    const batch = await db.transaction(async (tx) => {
      const [actor] = await tx.select().from(s.users).where(eq(s.users.id, userId));
      if (!actor?.active || !actor.isSuperuser) throw new ForbiddenException('Snapshot import requires an active administrator');
      const [rulebook] = await tx.select().from(s.tagRulebooks).where(eq(s.tagRulebooks.userId, userId)).for('share');
      const rows = libraryIds.length
        ? await tx
            .select({
              id: s.fanfictionSources.id,
              bookId: s.fanfictionSources.bookId,
              libraryId: s.fanfictionSources.libraryId,
              source: s.fanfictionSources.site,
              raw: s.fanfictionSources.rawLabels,
              categories: s.fanfictionSources.categories,
            })
            .from(s.fanfictionSources)
            .where(
              and(
                inArray(s.fanfictionSources.libraryId, libraryIds),
                isNotNull(s.fanfictionSources.bookId),
                ne(s.fanfictionSources.state, 'unlinked'),
                cursor ? gt(s.fanfictionSources.id, cursor) : undefined,
              ),
            )
            .orderBy(asc(s.fanfictionSources.id))
            .limit(100)
        : [];
      if (!rows.length) return { rows, inserted: 0 };
      if (apply) {
        const bindings = await tx
          .select()
          .from(s.libraryTagRulebooks)
          .where(inArray(s.libraryTagRulebooks.libraryId, [...new Set(rows.map((r) => r.libraryId))]));
        if (!rulebook || rows.some((r) => !bindings.some((b) => b.libraryId === r.libraryId && b.rulebookId === rulebook.id)))
          throw new ForbiddenException('Assign these libraries to this account before importing source evidence');
      }
      const claims = await tx
        .select({ bookId: s.bookTagSources.bookId, sourceKey: s.bookTagSources.sourceKey, value: s.tags.name })
        .from(s.bookTagSources)
        .innerJoin(s.tags, eq(s.tags.id, s.bookTagSources.tagId))
        .where(
          inArray(
            s.bookTagSources.bookId,
            rows.map((r) => r.bookId!),
          ),
        );
      const values: Array<typeof s.tagMatchingSnapshots.$inferInsert> = [];
      for (const row of rows) {
        const sourceKey = `fanfiction:${row.id}`;
        const labels: IncomingLabel[] = row.raw
          ? [...row.raw]
          : claims.filter((c) => c.bookId === row.bookId && c.sourceKey === sourceKey).map((c) => ({ field: 'tags', value: c.value }));
        if (!row.raw && row.categories) {
          for (const field of ['fandoms', 'characters', 'relationships', 'warnings'] as const)
            labels.push(...row.categories[field].map((value) => ({ field, value })));
          if (row.categories.rating) labels.push({ field: 'rating', value: row.categories.rating });
        }
        if (labels.length)
          values.push({ bookId: row.bookId!, userId, rulebookId: rulebook?.id ?? 0, sourceKey, source: row.source, labels, version: 0 });
      }
      const saved =
        apply && values.length
          ? await tx.insert(s.tagMatchingSnapshots).values(values).onConflictDoNothing().returning({ bookId: s.tagMatchingSnapshots.bookId })
          : [];
      return { rows, inserted: apply ? saved.length : values.length };
    });
    inserted += batch.inserted;
    examined += batch.rows.length;
    if (batch.rows.length < 100) break;
    cursor = batch.rows.at(-1)!.id;
  }
  return { examined, inserted };
}

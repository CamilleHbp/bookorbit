import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../db/transaction';
import * as s from '../../db/schema';
import { labelKey } from './match-labels';

type Field = 'tags' | 'genres';
@Injectable()
export class TagMatchingLifecycleService {
  private async lock(tx: DatabaseTransaction, field: Field, ids: number[], userId: number) {
    const [own] = await tx.select().from(s.tagRulebooks).where(eq(s.tagRulebooks.userId, userId)).for('update');
    const entities = field === 'tags' ? s.tags : s.genres;
    await tx.select({ id: entities.id }).from(entities).where(inArray(entities.id, ids)).orderBy(entities.id).for('update');
    const target = field === 'tags' ? s.tagMatchingTargets.tagId : s.tagMatchingTargets.genreId;
    const [foreign] = await tx
      .select({ id: s.tagMatchingTargets.id })
      .from(s.tagMatchingTargets)
      .innerJoin(s.tagMatchingRules, eq(s.tagMatchingRules.id, s.tagMatchingTargets.ruleId))
      .innerJoin(s.tagRulebooks, eq(s.tagRulebooks.id, s.tagMatchingRules.rulebookId))
      .where(and(inArray(target, ids), ne(s.tagRulebooks.userId, userId)))
      .limit(1);
    if (foreign) throw new ForbiddenException('This label is used by another matching database');
    const exclusion = field === 'tags' ? s.tagMatchingExclusions.tagId : s.tagMatchingExclusions.genreId;
    const [foreignExclusion] = await tx
      .select({ id: s.tagMatchingExclusions.id })
      .from(s.tagMatchingExclusions)
      .where(and(inArray(exclusion, ids), ne(s.tagMatchingExclusions.userId, userId)))
      .limit(1);
    if (foreignExclusion) throw new ForbiddenException('This label has exclusions owned by another account');
    return own;
  }
  private async aliases(tx: DatabaseTransaction, rulebookId: number, field: Field, id: number, names: string[]) {
    for (const name of new Set(names)) {
      for (const [source, inputField] of [
        ['', field],
        ['file', 'genres'],
      ] as const) {
        const [rule] = await tx
          .insert(s.tagMatchingRules)
          .values({ rulebookId, source, field: inputField, value: name, key: labelKey(name), action: 'match' })
          .onConflictDoNothing()
          .returning({ id: s.tagMatchingRules.id });
        if (rule) await tx.insert(s.tagMatchingTargets).values({ ruleId: rule.id, ...(field === 'tags' ? { tagId: id } : { genreId: id }) });
      }
    }
  }
  private async changed(tx: DatabaseTransaction, id: number) {
    await tx
      .update(s.tagRulebooks)
      .set({ version: sql`${s.tagRulebooks.version} + 1`, updatedAt: new Date() })
      .where(eq(s.tagRulebooks.id, id));
  }
  async rename(tx: DatabaseTransaction, field: Field, id: number, oldName: string, newName: string, userId: number) {
    const own = await this.lock(tx, field, [id], userId);
    if (!own) return;
    await this.aliases(tx, own.id, field, id, [oldName, newName]);
    await this.changed(tx, own.id);
  }
  async merge(tx: DatabaseTransaction, field: Field, sourceIds: number[], targetId: number, userId: number) {
    const own = await this.lock(tx, field, [...sourceIds, targetId], userId);
    if (!own) return;
    const table = field === 'tags' ? s.tags : s.genres;
    const names = await tx
      .select({ name: table.name })
      .from(table)
      .where(inArray(table.id, [...sourceIds, targetId]));
    const targetColumn = field === 'tags' ? s.tagMatchingTargets.tagId : s.tagMatchingTargets.genreId;
    const targetName = field === 'tags' ? sql`tag_id` : sql`genre_id`;
    await tx.execute(sql`insert into ${s.tagMatchingTargets} (rule_id, ${targetName})
      select rule_id, ${targetId} from ${s.tagMatchingTargets}
      where ${targetColumn} in (${sql.join(
        sourceIds.map((id) => sql`${id}`),
        sql`, `,
      )}) on conflict do nothing`);
    // Keep the combined manual/imported ownership before the old junction rows cascade away.
    const links = field === 'tags' ? s.bookTags : s.bookGenres;
    const entityId = field === 'tags' ? s.bookTags.tagId : s.bookGenres.genreId;
    const column = field === 'tags' ? sql`tag_id` : sql`genre_id`;
    const claims = field === 'tags' ? s.bookTagSources : s.bookGenreSources;
    const claimId = field === 'tags' ? s.bookTagSources.tagId : s.bookGenreSources.genreId;
    await tx.execute(sql`insert into ${links} (book_id, ${column}, managed_only)
      select book_id, ${targetId}, bool_and(managed_only) from ${links} where ${entityId} in (${sql.join(
        sourceIds.map((id) => sql`${id}`),
        sql`, `,
      )}) group by book_id
      on conflict (book_id, ${column}) do update set managed_only = ${links.managedOnly} and excluded.managed_only`);
    await tx.execute(sql`insert into ${claims} (book_id, ${column}, source_key)
      select book_id, ${targetId}, source_key from ${claims} where ${claimId} in (${sql.join(
        sourceIds.map((id) => sql`${id}`),
        sql`, `,
      )}) on conflict do nothing`);
    const exclusionId = field === 'tags' ? s.tagMatchingExclusions.tagId : s.tagMatchingExclusions.genreId;
    await tx.execute(sql`insert into ${s.tagMatchingExclusions} (book_id, user_id, ${column})
      select book_id, user_id, ${targetId} from ${s.tagMatchingExclusions} where ${exclusionId} in (${sql.join(
        sourceIds.map((id) => sql`${id}`),
        sql`, `,
      )}) and user_id = ${userId} on conflict do nothing`);
    await this.aliases(
      tx,
      own.id,
      field,
      targetId,
      names.map((row) => row.name),
    );
    await this.changed(tx, own.id);
  }
  async remove(tx: DatabaseTransaction, field: Field, id: number, userId: number, soft: boolean) {
    const own = await this.lock(tx, field, [id], userId);
    if (!own) return;
    if (soft) {
      const links = field === 'tags' ? s.bookTags : s.bookGenres;
      const entityId = field === 'tags' ? s.bookTags.tagId : s.bookGenres.genreId;
      const column = field === 'tags' ? sql`tag_id` : sql`genre_id`;
      await tx.execute(sql`insert into ${s.tagMatchingExclusions} (book_id, user_id, ${column})
        select book_id, ${userId}, ${id} from ${links} where ${entityId} = ${id} on conflict do nothing`);
    }
    await this.changed(tx, own.id);
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DB } from '../../db';
import * as s from '../../db/schema';
import type { DatabaseTransaction } from '../../db/transaction';
import type { RequestUser } from '../../common/types/request-user';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { LibraryService } from '../library/library.service';
import { labelKey } from './match-labels';
import type { MatchingPageDto, SaveMatchingRuleDto } from './tag-matching.dto';

@Injectable()
export class TagMatchingManagementService {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof s>,
    private readonly libraries: LibraryService,
  ) {}
  async own(user: RequestUser, tx: NodePgDatabase<typeof s> | DatabaseTransaction = this.db) {
    if (!user.active) throw new ForbiddenException('Account is inactive');
    const [row] = await tx.select().from(s.tagRulebooks).where(eq(s.tagRulebooks.userId, user.id));
    return row ?? null;
  }
  async initialize(user: RequestUser) {
    if (!user.active) throw new ForbiddenException('Account is inactive');
    await this.db.insert(s.tagRulebooks).values({ userId: user.id }).onConflictDoNothing();
    return this.own(user);
  }
  async attach(user: RequestUser, libraryId: number) {
    await this.libraries.verifyAdministration(user, libraryId);
    const own = await this.initialize(user);
    return this.db.transaction(async (tx) => {
      await tx.insert(s.libraryTagRulebooks).values({ libraryId, rulebookId: own!.id }).onConflictDoNothing();
      const [binding] = await tx.select().from(s.libraryTagRulebooks).where(eq(s.libraryTagRulebooks.libraryId, libraryId));
      if (binding.rulebookId !== own!.id) throw new ConflictException('This library already uses another matching database');
      return { libraryId, rulebookId: own!.id };
    });
  }
  async bookScope(user: RequestUser): Promise<SQL> {
    const ids = await this.libraries.findAccessibleLibraryIds(user);
    return and(
      ids.length ? inArray(s.books.libraryId, ids) : sql`false`,
      ...(!user.isSuperuser ? buildContentFilterClauses(user.contentFilters, this.db) : []),
    )!;
  }
  private async lock(user: RequestUser, version: number, tx: DatabaseTransaction) {
    const [own] = await tx.select().from(s.tagRulebooks).where(eq(s.tagRulebooks.userId, user.id)).for('update');
    if (!user.active || !own) throw new ForbiddenException('Matching database not available');
    if (own.version !== version) throw new ConflictException('Matches changed. Reload and try again.');
    return own;
  }
  async list(user: RequestUser, query: MatchingPageDto) {
    const own = await this.own(user);
    const empty = { items: [], total: 0, page: query.page, pageSize: query.pageSize, version: own?.version ?? 0 };
    if (!own) return empty;
    const where = and(
      eq(s.tagMatchingRules.rulebookId, own.id),
      query.search ? ilike(s.tagMatchingRules.value, `%${query.search}%`) : undefined,
      query.field ? eq(s.tagMatchingRules.field, query.field) : undefined,
      query.source !== undefined ? eq(s.tagMatchingRules.source, query.source) : undefined,
      query.action ? eq(s.tagMatchingRules.action, query.action) : undefined,
    );
    const [{ total }] = await this.db.select({ total: count() }).from(s.tagMatchingRules).where(where);
    const rows = await this.db
      .select()
      .from(s.tagMatchingRules)
      .where(where)
      .orderBy(asc(s.tagMatchingRules.value), asc(s.tagMatchingRules.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    if (!rows.length) return { ...empty, total };
    const targets = await this.db
      .select({
        ruleId: s.tagMatchingTargets.ruleId,
        tagId: s.tagMatchingTargets.tagId,
        genreId: s.tagMatchingTargets.genreId,
        tag: s.tags.name,
        genre: s.genres.name,
      })
      .from(s.tagMatchingTargets)
      .leftJoin(s.tags, eq(s.tags.id, s.tagMatchingTargets.tagId))
      .leftJoin(s.genres, eq(s.genres.id, s.tagMatchingTargets.genreId))
      .where(
        inArray(
          s.tagMatchingTargets.ruleId,
          rows.map((r) => r.id),
        ),
      );
    const scope = await this.bookScope(user);
    const counts = await this.db
      .select({ ruleId: s.tagMatchingRules.id, total: sql<number>`count(distinct ${s.books.id})::int` })
      .from(s.tagMatchingRules)
      .innerJoin(
        s.tagMatchingObservations,
        and(
          eq(s.tagMatchingObservations.rulebookId, s.tagMatchingRules.rulebookId),
          eq(s.tagMatchingObservations.field, s.tagMatchingRules.field),
          eq(s.tagMatchingObservations.key, s.tagMatchingRules.key),
          or(eq(s.tagMatchingRules.source, ''), eq(s.tagMatchingRules.source, s.tagMatchingObservations.source)),
        ),
      )
      .innerJoin(s.books, eq(s.books.id, s.tagMatchingObservations.bookId))
      .where(
        and(
          inArray(
            s.tagMatchingRules.id,
            rows.map((r) => r.id),
          ),
          scope,
        ),
      )
      .groupBy(s.tagMatchingRules.id);
    return {
      ...empty,
      total,
      items: rows.map((r) => ({
        id: r.id,
        version: own.version,
        source: r.source || null,
        field: r.field,
        value: r.value,
        action: r.action,
        targets: targets.filter((t) => t.ruleId === r.id).map((t) => ({ field: t.tagId !== null ? 'tags' : 'genres', id: t.tagId ?? t.genreId })),
        targetNames: targets.filter((t) => t.ruleId === r.id).map((t) => t.tag ?? t.genre),
        bookCount: counts.find((c) => c.ruleId === r.id)?.total ?? 0,
      })),
    };
  }
  async review(user: RequestUser, query: MatchingPageDto) {
    const own = await this.own(user);
    const empty = { items: [], total: 0, page: query.page, pageSize: query.pageSize, version: own?.version ?? 0 };
    if (!own) return empty;
    const scope = await this.bookScope(user);
    const o = s.tagMatchingObservations;
    // Compute unresolved status against current rules, so saving a match immediately clears its queue entry.
    const unresolved = sql`not exists (select 1 from tag_matching_rules r where r.rulebook_id=${own.id} and r.field=${o.field} and r.key=${o.key} and (r.source='' or r.source=${o.source}) and (r.action='ignore' or exists(select 1 from tag_matching_targets t where t.rule_id=r.id)) and not exists(select 1 from tag_matching_rules specific where r.source='' and specific.rulebook_id=r.rulebook_id and specific.field=r.field and specific.key=r.key and specific.source=${o.source}))`;
    const where = and(
      eq(o.rulebookId, own.id),
      sql`${o.status} <> 'suppressed'`,
      unresolved,
      scope,
      query.search ? ilike(o.value, `%${query.search}%`) : undefined,
      query.field ? eq(o.field, query.field) : undefined,
      query.source !== undefined ? eq(o.source, query.source) : undefined,
    );
    const grouped = this.db
      .select({
        source: o.source,
        field: o.field,
        key: o.key,
        value: sql<string>`min(${o.value})`.as('value'),
        bookCount: sql<number>`count(distinct ${o.bookId})::int`.as('book_count'),
      })
      .from(o)
      .innerJoin(s.books, eq(s.books.id, o.bookId))
      .where(where)
      .groupBy(o.source, o.field, o.key)
      .as('pending_labels');
    const [{ total }] = await this.db.select({ total: count() }).from(grouped);
    const items = await this.db
      .select()
      .from(grouped)
      .orderBy(asc(grouped.value), asc(grouped.source), asc(grouped.field))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    return { ...empty, total, items };
  }
  async suggestions(user: RequestUser, search: string, field?: 'tags' | 'genres') {
    const own = await this.own(user);
    if (!own) return [];
    const scope = await this.bookScope(user);
    const result: Array<{ field: 'tags' | 'genres'; id: number; name: string; score: number }> = [];
    for (const kind of field ? [field] : (['tags', 'genres'] as const)) {
      const table = kind === 'tags' ? s.tags : s.genres;
      const junction = kind === 'tags' ? s.bookTags : s.bookGenres;
      const entityId = kind === 'tags' ? s.bookTags.tagId : s.bookGenres.genreId;
      const targetId = kind === 'tags' ? s.tagMatchingTargets.tagId : s.tagMatchingTargets.genreId;
      const visible = or(
        sql`exists (${this.db
          .select({ id: s.books.id })
          .from(junction)
          .innerJoin(s.books, eq(s.books.id, junction.bookId))
          .where(and(eq(entityId, table.id), scope))})`,
        sql`exists (${this.db
          .select({ id: s.tagMatchingTargets.id })
          .from(s.tagMatchingTargets)
          .innerJoin(s.tagMatchingRules, eq(s.tagMatchingRules.id, s.tagMatchingTargets.ruleId))
          .where(and(eq(s.tagMatchingRules.rulebookId, own.id), eq(targetId, table.id)))})`,
      );
      const score = sql<number>`similarity(${table.name},${search})`;
      const rows = await this.db
        .select({ id: table.id, name: table.name, score })
        .from(table)
        .where(and(visible, or(ilike(table.name, `%${search}%`), sql`${score} > 0.2`)))
        .orderBy(sql`${score} desc`, asc(table.name))
        .limit(10);
      result.push(...rows.map((row) => ({ ...row, field: kind })));
    }
    return result.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 10);
  }

  async save(user: RequestUser, dto: SaveMatchingRuleDto) {
    if (dto.action === 'ignore' && (dto.targets.length || dto.newTargets?.length))
      throw new BadRequestException('Ignored labels cannot have targets');
    if (dto.action === 'match' && !dto.targets.length && !dto.newTargets?.length) throw new BadRequestException('Choose a tag or genre');
    const scope = await this.bookScope(user);
    return this.db.transaction(async (tx) => {
      const own = await this.lock(user, dto.version, tx);
      if (dto.id) {
        const [existing] = await tx
          .select({ id: s.tagMatchingRules.id })
          .from(s.tagMatchingRules)
          .where(and(eq(s.tagMatchingRules.id, dto.id), eq(s.tagMatchingRules.rulebookId, own.id)));
        if (!existing) throw new ForbiddenException('Rule is not available');
        const [collision] = await tx
          .select({ id: s.tagMatchingRules.id })
          .from(s.tagMatchingRules)
          .where(
            and(
              eq(s.tagMatchingRules.rulebookId, own.id),
              eq(s.tagMatchingRules.source, dto.source),
              eq(s.tagMatchingRules.field, dto.field),
              eq(s.tagMatchingRules.key, labelKey(dto.value)),
            ),
          );
        if (collision && collision.id !== dto.id) throw new ConflictException('A match for this label already exists');
      }
      for (const target of dto.targets) {
        const table = target.field === 'tags' ? s.tags : s.genres;
        const junction = target.field === 'tags' ? s.bookTags : s.bookGenres;
        const entityId = target.field === 'tags' ? s.bookTags.tagId : s.bookGenres.genreId;
        const targetId = target.field === 'tags' ? s.tagMatchingTargets.tagId : s.tagMatchingTargets.genreId;
        const [visible] = await tx
          .select({ id: table.id })
          .from(table)
          .where(
            and(
              eq(table.id, target.id),
              or(
                sql`exists (${tx
                  .select({ id: s.books.id })
                  .from(junction)
                  .innerJoin(s.books, eq(s.books.id, junction.bookId))
                  .where(and(eq(entityId, table.id), scope))})`,
                sql`exists (${tx
                  .select({ id: s.tagMatchingTargets.id })
                  .from(s.tagMatchingTargets)
                  .innerJoin(s.tagMatchingRules, eq(s.tagMatchingRules.id, s.tagMatchingTargets.ruleId))
                  .where(and(eq(s.tagMatchingRules.rulebookId, own.id), eq(targetId, table.id)))})`,
                user.isSuperuser ? sql`true` : sql`false`,
              ),
            ),
          );
        if (!visible) throw new ForbiddenException('Selected label is not available');
      }
      const targets = [...dto.targets];
      for (const item of dto.newTargets ?? []) {
        if (item.field === 'tags') {
          await tx.insert(s.tags).values({ name: item.name }).onConflictDoNothing();
          const [row] = await tx.select({ id: s.tags.id }).from(s.tags).where(eq(s.tags.name, item.name));
          targets.push({ field: 'tags', id: row.id });
        } else {
          await tx.insert(s.genres).values({ name: item.name }).onConflictDoNothing();
          const [row] = await tx.select({ id: s.genres.id }).from(s.genres).where(eq(s.genres.name, item.name));
          targets.push({ field: 'genres', id: row.id });
        }
      }
      const unique = [...new Map(targets.map((t) => [`${t.field}:${t.id}`, t])).values()];
      const canonical = new Map<string, { field: 'tags' | 'genres'; id: number; name: string }>();
      for (const field of ['tags', 'genres'] as const) {
        const ids = unique.filter((t) => t.field === field).map((t) => t.id);
        const table = field === 'tags' ? s.tags : s.genres;
        const rows = ids.length ? await tx.select({ id: table.id, name: table.name }).from(table).where(inArray(table.id, ids)) : [];
        if (rows.length !== ids.length) throw new BadRequestException('A selected label no longer exists');
        for (const row of rows) canonical.set(labelKey(row.name), { ...row, field });
      }
      const values = { rulebookId: own.id, source: dto.source, field: dto.field, value: dto.value, key: labelKey(dto.value), action: dto.action };
      const [rule] = dto.id
        ? await tx
            .update(s.tagMatchingRules)
            .set(values)
            .where(and(eq(s.tagMatchingRules.id, dto.id), eq(s.tagMatchingRules.rulebookId, own.id)))
            .returning()
        : await tx
            .insert(s.tagMatchingRules)
            .values(values)
            .onConflictDoUpdate({
              target: [s.tagMatchingRules.rulebookId, s.tagMatchingRules.source, s.tagMatchingRules.field, s.tagMatchingRules.key],
              set: { value: dto.value, action: dto.action },
            })
            .returning();
      await tx.delete(s.tagMatchingTargets).where(eq(s.tagMatchingTargets.ruleId, rule.id));
      if (unique.length)
        await tx
          .insert(s.tagMatchingTargets)
          .values(unique.map((t) => ({ ruleId: rule.id, ...(t.field === 'tags' ? { tagId: t.id } : { genreId: t.id }) })));
      // EPUB subjects arrive as genres. Remember each approved destination without replacing an explicit file rule.
      for (const [key, target] of canonical) {
        const [identity] = await tx
          .insert(s.tagMatchingRules)
          .values({
            rulebookId: own.id,
            source: 'file',
            field: 'genres',
            value: target.name,
            key,
            action: 'match',
          })
          .onConflictDoNothing()
          .returning({ id: s.tagMatchingRules.id });
        if (identity)
          await tx.insert(s.tagMatchingTargets).values({
            ruleId: identity.id,
            ...(target.field === 'tags' ? { tagId: target.id } : { genreId: target.id }),
          });
      }
      await tx
        .update(s.tagRulebooks)
        .set({ version: own.version + 1, updatedAt: new Date() })
        .where(eq(s.tagRulebooks.id, own.id));
      return { id: rule.id, version: own.version + 1 };
    });
  }
  async remove(user: RequestUser, id: string, version: number) {
    return this.db.transaction(async (tx) => {
      const own = await this.lock(user, version, tx);
      const rows = await tx
        .delete(s.tagMatchingRules)
        .where(and(eq(s.tagMatchingRules.id, id), eq(s.tagMatchingRules.rulebookId, own.id)))
        .returning({ id: s.tagMatchingRules.id });
      if (!rows.length) throw new ForbiddenException('Match is not owned by this account');
      await tx
        .update(s.tagRulebooks)
        .set({ version: own.version + 1, updatedAt: new Date() })
        .where(eq(s.tagRulebooks.id, own.id));
      return { version: own.version + 1 };
    });
  }
}

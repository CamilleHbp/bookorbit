import { Permission } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { ConflictException, BadRequestException, Inject, Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { IncomingLabel, LabelRule, LabelTarget, FanfictionPreview, FanfictionTagRule } from '@bookorbit/types';
import { DB } from '../../db';
import * as s from '../../db/schema';
import type { DatabaseTransaction } from '../../db/transaction';
import { labelKey, matchLabels } from './match-labels';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';

type Executor = NodePgDatabase<typeof s> | DatabaseTransaction;
export interface LabelImport {
  sourceKey: string;
  source: string;
  labels: IncomingLabel[];
  preserveFields?: Array<'tags' | 'genres'>;
}
const fields = new Set(['tags', 'genres', 'fandoms', 'characters', 'relationships', 'warnings', 'rating']);
export function validateLabels(input: LabelImport): void {
  if (
    !input.sourceKey ||
    input.sourceKey.length > 100 ||
    !input.source ||
    input.source.length > 200 ||
    (input.preserveFields !== undefined &&
      (!Array.isArray(input.preserveFields) || input.preserveFields.some((field) => field !== 'tags' && field !== 'genres'))) ||
    !Array.isArray(input.labels) ||
    input.labels.length > 5000 ||
    input.labels.some((l) => !l || !fields.has(l.field) || typeof l.value !== 'string' || l.value.length > 500)
  )
    throw new BadRequestException('Invalid imported labels');
}
export function storyLabels(preview: FanfictionPreview): IncomingLabel[] {
  if (preview.rawLabels) return preview.rawLabels;
  const labels: IncomingLabel[] = [
    ...preview.tags.map((value) => ({ field: 'tags' as const, value })),
    ...(preview.genres ?? []).map((value) => ({ field: 'genres' as const, value })),
  ];
  if (preview.categories) {
    for (const field of ['fandoms', 'characters', 'relationships', 'warnings'] as const)
      labels.push(...preview.categories[field].map((value) => ({ field, value })));
    if (preview.categories.rating) labels.push({ field: 'rating', value: preview.categories.rating });
  }
  return labels;
}
@Injectable()
export class TagMatchingService {
  private readonly logger = new Logger(TagMatchingService.name);
  constructor(@Inject(DB) private readonly db: NodePgDatabase<typeof s>) {}

  async binding(tx: Executor, libraryId: number) {
    const [binding] = await tx
      .select({ id: s.tagRulebooks.id, userId: s.tagRulebooks.userId, version: s.tagRulebooks.version })
      .from(s.libraryTagRulebooks)
      .innerJoin(s.tagRulebooks, eq(s.tagRulebooks.id, s.libraryTagRulebooks.rulebookId))
      .where(eq(s.libraryTagRulebooks.libraryId, libraryId));
    return binding ?? null;
  }

  async importLegacyRules(
    tx: DatabaseTransaction,
    user: Pick<RequestUser, 'id' | 'active' | 'isSuperuser' | 'permissions'>,
    source: string,
    rules: FanfictionTagRule[],
  ): Promise<number> {
    if (!user.active || (!user.isSuperuser && !user.permissions.includes(Permission.LibraryEditMetadata)))
      throw new ForbiddenException('Metadata editing permission is required');
    if (rules.length > 100) throw new BadRequestException('Too many legacy matches');
    if (!rules.length) return 0;
    await tx.insert(s.tagRulebooks).values({ userId: user.id }).onConflictDoNothing();
    const [own] = await tx.select().from(s.tagRulebooks).where(eq(s.tagRulebooks.userId, user.id)).for('update');
    let inserted = 0;
    for (const rule of rules) {
      validateLabels({
        source,
        sourceKey: 'legacy',
        labels: [
          { field: 'tags', value: rule.remoteTag },
          { field: 'tags', value: rule.targetTag },
        ],
      });
      const [existing] = await tx
        .select({ id: s.tagMatchingRules.id })
        .from(s.tagMatchingRules)
        .where(
          and(
            eq(s.tagMatchingRules.rulebookId, own.id),
            inArray(s.tagMatchingRules.source, ['', source]),
            eq(s.tagMatchingRules.field, 'tags'),
            eq(s.tagMatchingRules.key, labelKey(rule.remoteTag)),
          ),
        );
      if (existing) continue;
      const resolved = await this.resolve(tx, own.id, source, [{ field: 'tags', value: rule.targetTag }]);
      const targets = [...resolved.targets];
      const [knownTarget] = await tx
        .select({ id: s.tagMatchingRules.id })
        .from(s.tagMatchingRules)
        .where(
          and(
            eq(s.tagMatchingRules.rulebookId, own.id),
            inArray(s.tagMatchingRules.source, ['', source]),
            eq(s.tagMatchingRules.field, 'tags'),
            eq(s.tagMatchingRules.key, labelKey(rule.targetTag)),
          ),
        );
      if (!knownTarget && !targets.length) {
        const [tag] = await tx
          .select({ id: s.tags.id })
          .from(s.tags)
          .where(
            and(
              eq(s.tags.name, rule.targetTag.trim()),
              sql`exists (select 1 from ${s.bookTags} join ${s.books} on ${s.books.id} = ${s.bookTags.bookId}
            join ${s.libraryTagRulebooks} on ${s.libraryTagRulebooks.libraryId} = ${s.books.libraryId}
            where ${s.bookTags.tagId} = ${s.tags.id} and ${s.libraryTagRulebooks.rulebookId} = ${own.id})`,
            ),
          );
        if (tag) targets.push({ field: 'tags', id: tag.id });
      }
      const [created] = await tx
        .insert(s.tagMatchingRules)
        .values({
          rulebookId: own.id,
          source,
          field: 'tags',
          value: rule.remoteTag,
          key: labelKey(rule.remoteTag),
          action: resolved.ignored.length ? 'ignore' : 'match',
        })
        .returning();
      if (targets.length)
        await tx
          .insert(s.tagMatchingTargets)
          .values(targets.map((target) => ({ ruleId: created.id, ...(target.field === 'tags' ? { tagId: target.id } : { genreId: target.id }) })));
      inserted++;
    }
    if (inserted)
      await tx
        .update(s.tagRulebooks)
        .set({ version: own.version + 1, updatedAt: new Date() })
        .where(eq(s.tagRulebooks.id, own.id));
    return inserted;
  }

  async assignNewLibrary(user: RequestUser, libraryId: number): Promise<void> {
    if (!user.active) throw new ForbiddenException('Account is inactive');
    await this.db.transaction(async (tx) => {
      await tx.insert(s.tagRulebooks).values({ userId: user.id }).onConflictDoNothing();
      const [own] = await tx.select({ id: s.tagRulebooks.id }).from(s.tagRulebooks).where(eq(s.tagRulebooks.userId, user.id));
      await tx.insert(s.libraryTagRulebooks).values({ libraryId, rulebookId: own.id });
    });
  }

  async isCurrent(libraryId: number, version: number | null | undefined): Promise<boolean> {
    const binding = await this.binding(this.db, libraryId);
    return !binding || binding.version === version;
  }

  async assertCurrentVersion(tx: DatabaseTransaction, libraryId: number, version: number | null | undefined): Promise<void> {
    const binding = await this.binding(tx, libraryId);
    if (!binding) return;
    const [rulebook] = await tx
      .select({ version: s.tagRulebooks.version })
      .from(s.tagRulebooks)
      .where(eq(s.tagRulebooks.id, binding.id))
      .for('share');
    if (!rulebook || rulebook.version !== version) {
      throw new ConflictException({ message: 'Tag matches changed. Refresh the story preview before continuing.', errorCode: 'tag_matches_changed' });
    }
  }

  async importLabels(bookId: number, input: LabelImport) {
    return this.db.transaction((tx) => this.sync(tx, bookId, input));
  }

  async resolve(tx: Executor, rulebookId: number, source: string, labels: IncomingLabel[]) {
    validateLabels({ sourceKey: 'preview', source, labels });
    const keys = [...new Set(labels.map((l) => labelKey(l.value)))];
    const rules = keys.length
      ? await tx
          .select()
          .from(s.tagMatchingRules)
          .where(
            and(
              eq(s.tagMatchingRules.rulebookId, rulebookId),
              inArray(s.tagMatchingRules.source, ['', source]),
              inArray(s.tagMatchingRules.key, keys),
            ),
          )
      : [];
    const targets = rules.length
      ? await tx
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
              rules.map((r) => r.id),
            ),
          )
      : [];
    const names = new Map<string, string>();
    const byRule = new Map<string, LabelTarget[]>();
    for (const target of targets) {
      const field = target.tagId !== null ? 'tags' : 'genres';
      const id = target.tagId ?? target.genreId!;
      names.set(`${field}:${id}`, target.tag ?? target.genre!);
      const list = byRule.get(target.ruleId) ?? [];
      list.push({ field, id });
      byRule.set(target.ruleId, list);
    }
    // Missing targets stay unresolved. Source-specific deleted targets also shadow general aliases.
    const blocked = new Set(
      rules.filter((r) => r.source === source && r.action === 'match' && !byRule.has(r.id)).map((r) => JSON.stringify([r.field, r.key])),
    );
    const active: LabelRule[] = rules
      .filter((r) => (r.action === 'ignore' || byRule.has(r.id)) && (r.source !== '' || !blocked.has(JSON.stringify([r.field, r.key]))))
      .map((r) => ({ source: r.source || null, field: r.field, value: r.value, targets: r.action === 'ignore' ? [] : byRule.get(r.id)! }));
    return { ...matchLabels(source, labels, active), names, rules: active };
  }

  async runtimePolicy(libraryId: number): Promise<import('@bookorbit/types').FanfictionConnectionDocument['tagMatching']> {
    return this.db.transaction(async (tx) => {
      const binding = await this.binding(tx, libraryId);
      if (!binding) return undefined;
      const [book] = await tx.select().from(s.tagRulebooks).where(eq(s.tagRulebooks.id, binding.id)).for('share');
      const rows = await tx.select().from(s.tagMatchingRules).where(eq(s.tagMatchingRules.rulebookId, binding.id)).limit(20001);
      if (rows.length > 20000) throw new BadRequestException('Too many matches for a story import');
      const targets = rows.length
        ? await tx
            .select({ ruleId: s.tagMatchingTargets.ruleId, tag: s.tags.name, genre: s.genres.name })
            .from(s.tagMatchingTargets)
            .innerJoin(s.tagMatchingRules, eq(s.tagMatchingRules.id, s.tagMatchingTargets.ruleId))
            .leftJoin(s.tags, eq(s.tags.id, s.tagMatchingTargets.tagId))
            .leftJoin(s.genres, eq(s.genres.id, s.tagMatchingTargets.genreId))
            .where(eq(s.tagMatchingRules.rulebookId, binding.id))
        : [];
      const grouped = new Map<string, Array<{ field: 'tags' | 'genres'; name: string }>>();
      for (const target of targets) {
        const list = grouped.get(target.ruleId) ?? [];
        list.push({ field: target.tag ? 'tags' : 'genres', name: target.tag ?? target.genre! });
        grouped.set(target.ruleId, list);
      }
      const rules = rows.map((r) => ({
        source: r.source || null,
        field: r.field,
        value: r.value,
        targets: grouped.get(r.id) ?? [],
        action: r.action,
      }));
      // Preserve deleted overrides as unresolved entries in the runtime protocol.
      return { version: book.version, rules: rules.map((r) => ({ ...r, unresolved: r.action === 'match' && !r.targets.length })) };
    });
  }

  async preview(libraryId: number, input: LabelImport) {
    validateLabels(input);
    return this.db.transaction(async (tx) => {
      const binding = await this.binding(tx, libraryId);
      if (!binding) return null;
      const [current] = await tx.select().from(s.tagRulebooks).where(eq(s.tagRulebooks.id, binding.id)).for('share');
      const resolved = await this.resolve(tx, binding.id, input.source, input.labels);
      return {
        version: current.version,
        tags: resolved.targets.filter((t) => t.field === 'tags').map((t) => resolved.names.get(`tags:${t.id}`)!),
        genres: resolved.targets.filter((t) => t.field === 'genres').map((t) => resolved.names.get(`genres:${t.id}`)!),
        pending: resolved.pending,
      };
    });
  }

  async sync(
    tx: DatabaseTransaction,
    bookId: number,
    input: LabelImport,
    options: { expectedVersion?: number; overrideFields?: Array<'tags' | 'genres'> } = {},
  ) {
    validateLabels(input);
    const [book] = await tx.select({ libraryId: s.books.libraryId }).from(s.books).where(eq(s.books.id, bookId));
    if (!book) throw new NotFoundException('Book not found');
    const binding = await this.binding(tx, book.libraryId);
    if (!binding) return null;
    const startedAt = Date.now();
    this.logger.log(
      `[tag_matching] [start] bookId=${bookId} rulebookId=${binding.id} source="${sanitizeLogValue(input.source)}" labels=${input.labels.length} - matching imported labels`,
    );
    try {
      const [rulebook] = await tx.select().from(s.tagRulebooks).where(eq(s.tagRulebooks.id, binding.id)).for('share');
      if (options.expectedVersion !== undefined && options.expectedVersion !== rulebook.version)
        throw new ConflictException('Tag matches changed. Preview again.');
      const [metadata] = await tx
        .select({ lockedFields: s.bookMetadata.lockedFields })
        .from(s.bookMetadata)
        .where(eq(s.bookMetadata.bookId, bookId))
        .for('update');
      if (!metadata) throw new NotFoundException('Book metadata not found');
      if (input.preserveFields?.length) {
        const [previous] = await tx
          .select({ labels: s.tagMatchingSnapshots.labels })
          .from(s.tagMatchingSnapshots)
          .where(
            and(
              eq(s.tagMatchingSnapshots.bookId, bookId),
              eq(s.tagMatchingSnapshots.sourceKey, input.sourceKey),
              eq(s.tagMatchingSnapshots.rulebookId, binding.id),
            ),
          );
        const preserved = new Set<string>(input.preserveFields);
        input = {
          ...input,
          labels: [
            ...input.labels.filter((label) => !preserved.has(label.field)),
            ...(previous?.labels ?? []).filter((label) => preserved.has(label.field)),
          ],
        };
        validateLabels(input);
      }

      const resolved = await this.resolve(tx, binding.id, input.source, input.labels);
      const pending = new Set(resolved.pending.map((l) => JSON.stringify([l.field, labelKey(l.value)])));
      const ignored = new Set(resolved.ignored.map((l) => JSON.stringify([l.field, labelKey(l.value)])));
      const suppressed = new Set(resolved.suppressed.map((l) => JSON.stringify([l.field, labelKey(l.value)])));
      await tx
        .insert(s.tagMatchingSnapshots)
        .values({
          bookId,
          sourceKey: input.sourceKey,
          source: input.source,
          userId: binding.userId,
          rulebookId: binding.id,
          version: rulebook.version,
          labels: input.labels,
        })
        .onConflictDoUpdate({
          target: [s.tagMatchingSnapshots.bookId, s.tagMatchingSnapshots.sourceKey],
          set: {
            source: input.source,
            userId: binding.userId,
            rulebookId: binding.id,
            version: rulebook.version,
            labels: input.labels,
            updatedAt: new Date(),
          },
        });
      await tx
        .delete(s.tagMatchingObservations)
        .where(and(eq(s.tagMatchingObservations.bookId, bookId), eq(s.tagMatchingObservations.sourceKey, input.sourceKey)));
      const unique = new Map(input.labels.filter((l) => labelKey(l.value)).map((l) => [JSON.stringify([l.field, labelKey(l.value)]), l]));
      const rows = [...unique].map(([key, l]) => ({
        bookId,
        sourceKey: input.sourceKey,
        rulebookId: binding.id,
        source: input.source,
        field: l.field,
        key: labelKey(l.value),
        value: l.value,
        status: suppressed.has(key)
          ? ('suppressed' as const)
          : pending.has(key)
            ? ('pending' as const)
            : ignored.has(key)
              ? ('ignored' as const)
              : ('matched' as const),
      }));
      for (let i = 0; i < rows.length; i += 250) await tx.insert(s.tagMatchingObservations).values(rows.slice(i, i + 250));
      const exclusions = await tx.select().from(s.tagMatchingExclusions).where(eq(s.tagMatchingExclusions.bookId, bookId));
      const selected = resolved.targets.filter((t) => !exclusions.some((e) => (t.field === 'tags' ? e.tagId === t.id : e.genreId === t.id)));
      for (const field of ['tags', 'genres'] as const) {
        if (metadata.lockedFields.includes(field) && !options.overrideFields?.includes(field)) continue;
        await this.syncAssignments(
          tx,
          bookId,
          input.sourceKey,
          field,
          selected.filter((t) => t.field === field).map((t) => t.id),
        );
      }
      this.logger.log(
        `[tag_matching] [end] bookId=${bookId} rulebookId=${binding.id} durationMs=${Date.now() - startedAt} matched=${selected.length} pending=${pending.size} suppressed=${suppressed.size} - labels processed`,
      );
      return { version: rulebook.version, pending: pending.size, targets: selected };
    } catch (error) {
      this.logger.warn(
        `[tag_matching] [fail] bookId=${bookId} rulebookId=${binding.id} durationMs=${Date.now() - startedAt} errorClass=LabelMatchingError error="label matching failed" - imported labels were not applied`,
      );
      throw error;
    }
  }

  private async syncAssignments(tx: DatabaseTransaction, bookId: number, sourceKey: string, field: 'tags' | 'genres', ids: number[]) {
    if (field === 'tags') {
      await tx.delete(s.bookTagSources).where(and(eq(s.bookTagSources.bookId, bookId), eq(s.bookTagSources.sourceKey, sourceKey)));
      if (ids.length) {
        await tx
          .insert(s.bookTags)
          .values(ids.map((tagId) => ({ bookId, tagId, managedOnly: true })))
          .onConflictDoNothing();
        await tx
          .insert(s.bookTagSources)
          .values(ids.map((tagId) => ({ bookId, tagId, sourceKey })))
          .onConflictDoNothing();
      }
      await tx.delete(s.bookTags).where(
        and(
          eq(s.bookTags.bookId, bookId),
          eq(s.bookTags.managedOnly, true),
          notExists(
            tx
              .select({ id: s.bookTagSources.tagId })
              .from(s.bookTagSources)
              .where(and(eq(s.bookTagSources.bookId, bookId), eq(s.bookTagSources.tagId, s.bookTags.tagId))),
          ),
        ),
      );
    } else {
      await tx.delete(s.bookGenreSources).where(and(eq(s.bookGenreSources.bookId, bookId), eq(s.bookGenreSources.sourceKey, sourceKey)));
      if (ids.length) {
        await tx
          .insert(s.bookGenres)
          .values(ids.map((genreId) => ({ bookId, genreId, managedOnly: true })))
          .onConflictDoNothing();
        await tx
          .insert(s.bookGenreSources)
          .values(ids.map((genreId) => ({ bookId, genreId, sourceKey })))
          .onConflictDoNothing();
      }
      await tx.delete(s.bookGenres).where(
        and(
          eq(s.bookGenres.bookId, bookId),
          eq(s.bookGenres.managedOnly, true),
          notExists(
            tx
              .select({ id: s.bookGenreSources.genreId })
              .from(s.bookGenreSources)
              .where(and(eq(s.bookGenreSources.bookId, bookId), eq(s.bookGenreSources.genreId, s.bookGenres.genreId))),
          ),
        ),
      );
    }
  }

  async editManualLabels(
    tx: DatabaseTransaction,
    bookId: number,
    field: 'tags' | 'genres',
    edits: { added: string[]; removed: string[] },
    userId: number,
  ) {
    const added = [...new Set(edits.added.map((name) => name.trim()).filter(Boolean))];
    const removed = [...new Set(edits.removed.map((name) => name.trim()).filter(Boolean))];
    if (added.length + removed.length > 2000 || [...added, ...removed].some((name) => name.length > 200))
      throw new BadRequestException('Too many or oversized manual labels');
    const table = field === 'tags' ? s.tags : s.genres;
    if (added.length)
      await tx
        .insert(table)
        .values(added.map((name) => ({ name })))
        .onConflictDoNothing();
    const selected = added.length ? await tx.select({ id: table.id }).from(table).where(inArray(table.name, added)) : [];
    const excluded = removed.length ? await tx.select({ id: table.id }).from(table).where(inArray(table.name, removed)) : [];
    if (selected.length) {
      const ids = selected.map((row) => row.id);
      if (field === 'tags')
        await tx
          .insert(s.bookTags)
          .values(ids.map((tagId) => ({ bookId, tagId, managedOnly: false })))
          .onConflictDoUpdate({ target: [s.bookTags.bookId, s.bookTags.tagId], set: { managedOnly: false } });
      else
        await tx
          .insert(s.bookGenres)
          .values(ids.map((genreId) => ({ bookId, genreId, managedOnly: false })))
          .onConflictDoUpdate({ target: [s.bookGenres.bookId, s.bookGenres.genreId], set: { managedOnly: false } });
      await tx
        .delete(s.tagMatchingExclusions)
        .where(
          and(
            eq(s.tagMatchingExclusions.bookId, bookId),
            inArray(field === 'tags' ? s.tagMatchingExclusions.tagId : s.tagMatchingExclusions.genreId, ids),
          ),
        );
    }
    if (excluded.length) {
      const ids = excluded.map((row) => row.id);
      await tx
        .insert(s.tagMatchingExclusions)
        .values(ids.map((id) => ({ bookId, userId, ...(field === 'tags' ? { tagId: id } : { genreId: id }) })))
        .onConflictDoNothing();
      if (field === 'tags') await tx.delete(s.bookTags).where(and(eq(s.bookTags.bookId, bookId), inArray(s.bookTags.tagId, ids)));
      else await tx.delete(s.bookGenres).where(and(eq(s.bookGenres.bookId, bookId), inArray(s.bookGenres.genreId, ids)));
    }
  }

  async manualSelection(tx: DatabaseTransaction, bookId: number, field: 'tags' | 'genres', names: string[], userId: number) {
    const keys = new Set(names.map(labelKey));
    const current =
      field === 'tags'
        ? await tx
            .select({ id: s.tags.id, name: s.tags.name })
            .from(s.bookTags)
            .innerJoin(s.tags, eq(s.tags.id, s.bookTags.tagId))
            .where(eq(s.bookTags.bookId, bookId))
        : await tx
            .select({ id: s.genres.id, name: s.genres.name })
            .from(s.bookGenres)
            .innerJoin(s.genres, eq(s.genres.id, s.bookGenres.genreId))
            .where(eq(s.bookGenres.bookId, bookId));
    const removed = current.filter((r) => !keys.has(labelKey(r.name)));
    if (removed.length)
      await tx
        .insert(s.tagMatchingExclusions)
        .values(removed.map((r) => ({ bookId, userId, ...(field === 'tags' ? { tagId: r.id } : { genreId: r.id }) })))
        .onConflictDoNothing();
    const table = field === 'tags' ? s.tags : s.genres;
    const retained = names.length
      ? (
          await tx
            .select({ id: table.id })
            .from(table)
            .where(
              inArray(
                table.name,
                names.map((name) => name.trim()),
              ),
            )
        ).map((row) => row.id)
      : [];
    if (retained.length)
      await tx
        .delete(s.tagMatchingExclusions)
        .where(
          and(
            eq(s.tagMatchingExclusions.bookId, bookId),
            inArray(field === 'tags' ? s.tagMatchingExclusions.tagId : s.tagMatchingExclusions.genreId, retained),
          ),
        );
    if (field === 'tags') await tx.update(s.bookTags).set({ managedOnly: false }).where(eq(s.bookTags.bookId, bookId));
    else await tx.update(s.bookGenres).set({ managedOnly: false }).where(eq(s.bookGenres.bookId, bookId));
  }
}

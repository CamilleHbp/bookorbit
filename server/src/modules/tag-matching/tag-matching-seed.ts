import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { LabelField } from '@bookorbit/types';
import * as s from '../../db/schema';
import { labelKey } from './match-labels';

type SeedTarget = { field: 'tags' | 'genres'; name: string };
export interface MatchingSeedRule {
  source: string;
  field: LabelField;
  value: string;
  action: 'match' | 'ignore';
  targets: SeedTarget[];
}
const fields = new Set(['tags', 'genres', 'fandoms', 'characters', 'relationships', 'warnings', 'rating']);
const ruleKey = (rule: Pick<MatchingSeedRule, 'source' | 'field' | 'value'>) => JSON.stringify([rule.source, rule.field, labelKey(rule.value)]);
export function parseMatchingSeed(input: unknown): MatchingSeedRule[] {
  if (
    !input ||
    typeof input !== 'object' ||
    !('schemaVersion' in input) ||
    input.schemaVersion !== 1 ||
    !('rules' in input) ||
    !Array.isArray(input.rules) ||
    input.rules.length > 20000
  )
    throw new BadRequestException('Invalid matching seed');
  const seen = new Set<string>();
  for (const value of input.rules) {
    const r = value as MatchingSeedRule;
    if (
      !r ||
      typeof r.source !== 'string' ||
      r.source.length > 200 ||
      !fields.has(r.field) ||
      typeof r.value !== 'string' ||
      !labelKey(r.value) ||
      r.value.length > 500 ||
      !['match', 'ignore'].includes(r.action) ||
      !Array.isArray(r.targets) ||
      r.targets.length > 20 ||
      (r.action === 'match' ? r.targets.length === 0 : r.targets.length !== 0) ||
      r.targets.some((t) => !t || !['tags', 'genres'].includes(t.field) || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 200)
    )
      throw new BadRequestException('Invalid matching seed rule');
    const key = ruleKey(r);
    if (seen.has(key)) throw new BadRequestException('Duplicate matching seed rule');
    seen.add(key);
  }
  return input.rules as MatchingSeedRule[];
}

/** Operator-only import. Existing matches are retained; replacing ignores requires explicit opt-in. */
export async function importMatchingSeed(
  db: NodePgDatabase<typeof s>,
  userId: number,
  libraryIds: number[],
  input: unknown,
  apply: boolean,
  replaceIgnoredFandoms = false,
) {
  const rules = parseMatchingSeed(input);
  if (!libraryIds.length || libraryIds.length > 1000 || libraryIds.some((id) => !Number.isSafeInteger(id) || id < 1))
    throw new BadRequestException('Choose the libraries for this rulebook');
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ active: s.users.active, isSuperuser: s.users.isSuperuser }).from(s.users).where(eq(s.users.id, userId));
    if (!user?.active || !user.isSuperuser) throw new ForbiddenException('The deployment seed requires an active superuser account');
    const libraries = await tx
      .select({ id: s.libraries.id })
      .from(s.libraries)
      .where(and(inArray(s.libraries.id, libraryIds), eq(s.libraries.type, 'books')));
    if (libraries.length !== new Set(libraryIds).size) throw new BadRequestException('A selected book library is unavailable');
    const [foreign] = await tx
      .select({ id: s.libraryTagRulebooks.libraryId })
      .from(s.libraryTagRulebooks)
      .innerJoin(s.tagRulebooks, eq(s.tagRulebooks.id, s.libraryTagRulebooks.rulebookId))
      .where(and(inArray(s.libraryTagRulebooks.libraryId, libraryIds), ne(s.tagRulebooks.userId, userId)))
      .limit(1);
    if (foreign) throw new ConflictException('A library uses another account’s matching database');
    if (apply) await tx.insert(s.tagRulebooks).values({ userId }).onConflictDoNothing();
    const [own] = await tx.select().from(s.tagRulebooks).where(eq(s.tagRulebooks.userId, userId)).for('update');
    const existing = new Set<string>();
    const ignoredIds = new Map<string, string>();
    if (own) {
      const keys = [...new Set(rules.map((r) => labelKey(r.value)))];
      for (let offset = 0; offset < keys.length; offset += 1000) {
        const rows = await tx
          .select({
            id: s.tagMatchingRules.id,
            action: s.tagMatchingRules.action,
            source: s.tagMatchingRules.source,
            field: s.tagMatchingRules.field,
            value: s.tagMatchingRules.value,
          })
          .from(s.tagMatchingRules)
          .where(and(eq(s.tagMatchingRules.rulebookId, own.id), inArray(s.tagMatchingRules.key, keys.slice(offset, offset + 1000))));
        rows.forEach((row) => {
          existing.add(ruleKey(row));
          if (row.action === 'ignore') ignoredIds.set(ruleKey(row), row.id);
        });
      }
    }
    const replacements = new Map(
      rules
        .filter(
          (rule) =>
            replaceIgnoredFandoms &&
            ignoredIds.has(ruleKey(rule)) &&
            rule.action === 'match' &&
            rule.targets.every((target) => target.field === 'tags' && target.name.startsWith('fandom.')),
        )
        .map((rule) => [ruleKey(rule), ignoredIds.get(ruleKey(rule))!]),
    );
    const pending = rules.filter((rule) => !existing.has(ruleKey(rule)) || replacements.has(ruleKey(rule)));
    const canonical = new Map<string, number>();
    for (const field of ['tags', 'genres'] as const) {
      const names = [...new Set(pending.flatMap((rule) => rule.targets.filter((t) => t.field === field).map((t) => t.name)))];
      const table = field === 'tags' ? s.tags : s.genres;
      for (let offset = 0; offset < names.length; offset += 1000) {
        const rows = await tx
          .select({ id: table.id, name: table.name })
          .from(table)
          .where(inArray(table.name, names.slice(offset, offset + 1000)));
        rows.forEach((row) => canonical.set(JSON.stringify([field, row.name]), row.id));
      }
      if (names.some((name) => !canonical.has(JSON.stringify([field, name]))))
        throw new BadRequestException('A seed destination is missing; review the private seed before applying');
    }
    if (apply && own) {
      const byKey = new Map(pending.map((rule) => [ruleKey(rule), rule]));
      for (let offset = 0; offset < pending.length; offset += 250) {
        const batch = pending.slice(offset, offset + 250);
        const replacementIds = batch.flatMap((rule) => (replacements.has(ruleKey(rule)) ? [replacements.get(ruleKey(rule))!] : []));
        const replaced = replacementIds.length
          ? await tx
              .update(s.tagMatchingRules)
              .set({ action: 'match' })
              .where(
                and(
                  eq(s.tagMatchingRules.rulebookId, own.id),
                  eq(s.tagMatchingRules.action, 'ignore'),
                  inArray(s.tagMatchingRules.id, replacementIds),
                ),
              )
              .returning()
          : [];
        const additions = batch.filter((rule) => !replacements.has(ruleKey(rule)));
        const inserted = additions.length
          ? await tx
              .insert(s.tagMatchingRules)
              .values(
                additions.map((rule) => ({
                  rulebookId: own.id,
                  source: rule.source,
                  field: rule.field,
                  value: rule.value,
                  key: labelKey(rule.value),
                  action: rule.action,
                })),
              )
              .returning()
          : [];
        const targets = [...inserted, ...replaced].flatMap((rule) =>
          byKey.get(ruleKey(rule))!.targets.map((target) => ({
            ruleId: rule.id,
            ...(target.field === 'tags'
              ? { tagId: canonical.get(JSON.stringify([target.field, target.name]))! }
              : { genreId: canonical.get(JSON.stringify([target.field, target.name]))! }),
          })),
        );
        if (targets.length) await tx.insert(s.tagMatchingTargets).values(targets).onConflictDoNothing();
      }
      await tx
        .insert(s.libraryTagRulebooks)
        .values([...new Set(libraryIds)].map((libraryId) => ({ libraryId, rulebookId: own.id })))
        .onConflictDoNothing();
      if (pending.length)
        await tx
          .update(s.tagRulebooks)
          .set({ version: own.version + 1, updatedAt: new Date() })
          .where(eq(s.tagRulebooks.id, own.id));
    }
    return {
      applied: apply,
      inserted: pending.length - replacements.size,
      replaced: replacements.size,
      retained: rules.length - pending.length,
      libraries: libraries.length,
      version: (own?.version ?? 1) + (apply && pending.length ? 1 : 0),
    };
  });
}

import { sql } from 'drizzle-orm';
import { pgTable, serial, integer, uuid, varchar, timestamp, jsonb, index, uniqueIndex, primaryKey, check, foreignKey } from 'drizzle-orm/pg-core';
import type { IncomingLabel, LabelField, TagMatchingChange } from '@bookorbit/types';
import { users } from './auth';
import { libraries } from './libraries';
import { books } from './books';
import { tags, genres, bookGenres } from './metadata';

export const tagRulebooks = pgTable('tag_rulebooks', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' })
    .unique(),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const libraryTagRulebooks = pgTable(
  'library_tag_rulebooks',
  {
    libraryId: integer('library_id')
      .primaryKey()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    rulebookId: integer('rulebook_id')
      .notNull()
      .references(() => tagRulebooks.id, { onDelete: 'restrict' }),
  },
  (t) => [index('library_tag_rulebook_idx').on(t.rulebookId)],
);
export const tagMatchingRules = pgTable(
  'tag_matching_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rulebookId: integer('rulebook_id')
      .notNull()
      .references(() => tagRulebooks.id, { onDelete: 'cascade' }),
    source: varchar('source', { length: 200 }).notNull().default(''),
    field: varchar('field', { length: 20 }).$type<LabelField>().notNull(),
    value: varchar('value', { length: 500 }).notNull(),
    key: varchar('key', { length: 1000 }).notNull(),
    action: varchar('action', { length: 10 }).$type<'match' | 'ignore'>().notNull(),
  },
  (t) => [
    uniqueIndex('tag_match_rule_key_idx').on(t.rulebookId, t.source, t.field, t.key),
    check('tag_match_rule_action_chk', sql`${t.action} in ('match','ignore')`),
    check('tag_match_rule_field_chk', sql`${t.field} in ('tags','genres','fandoms','characters','relationships','warnings','rating')`),
  ],
);
export const tagMatchingTargets = pgTable(
  'tag_matching_targets',
  {
    id: serial('id').primaryKey(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => tagMatchingRules.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id').references(() => tags.id, { onDelete: 'cascade' }),
    genreId: integer('genre_id').references(() => genres.id, { onDelete: 'cascade' }),
  },
  (t) => [
    check('tag_match_target_one_chk', sql`num_nonnulls(${t.tagId},${t.genreId}) = 1`),
    uniqueIndex('tag_match_target_tag_idx').on(t.ruleId, t.tagId),
    uniqueIndex('tag_match_target_genre_idx').on(t.ruleId, t.genreId),
    index('tag_match_target_tag_reverse_idx').on(t.tagId),
    index('tag_match_target_genre_reverse_idx').on(t.genreId),
  ],
);
export const tagMatchingSnapshots = pgTable(
  'tag_matching_snapshots',
  {
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    sourceKey: varchar('source_key', { length: 100 }).notNull(),
    source: varchar('source', { length: 200 }).notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rulebookId: integer('rulebook_id')
      .notNull()
      .references(() => tagRulebooks.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    labels: jsonb('labels').$type<IncomingLabel[]>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.sourceKey] }),
    index('tag_match_snapshots_owner_idx').on(t.userId, t.bookId),
    index('tag_match_snapshots_rulebook_idx').on(t.rulebookId, t.bookId),
  ],
);
export const tagMatchingObservations = pgTable(
  'tag_matching_observations',
  {
    id: serial('id').primaryKey(),
    bookId: integer('book_id').notNull(),
    sourceKey: varchar('source_key', { length: 100 }).notNull(),
    rulebookId: integer('rulebook_id')
      .notNull()
      .references(() => tagRulebooks.id, { onDelete: 'cascade' }),
    source: varchar('source', { length: 200 }).notNull(),
    field: varchar('field', { length: 20 }).$type<LabelField>().notNull(),
    key: varchar('key', { length: 1000 }).notNull(),
    value: varchar('value', { length: 500 }).notNull(),
    status: varchar('status', { length: 12 }).$type<'pending' | 'matched' | 'ignored' | 'suppressed'>().notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.bookId, t.sourceKey], foreignColumns: [tagMatchingSnapshots.bookId, tagMatchingSnapshots.sourceKey] }).onDelete(
      'cascade',
    ),
    uniqueIndex('tag_match_observation_key_idx').on(t.bookId, t.sourceKey, t.field, t.key),
    index('tag_match_observation_review_idx').on(t.rulebookId, t.status, t.source, t.field),
    index('tag_match_observation_lookup_idx').on(t.rulebookId, t.field, t.key),
  ],
);
export const bookGenreSources = pgTable(
  'book_genre_sources',
  {
    bookId: integer('book_id').notNull(),
    genreId: integer('genre_id').notNull(),
    sourceKey: varchar('source_key', { length: 100 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.genreId, t.sourceKey] }),
    foreignKey({ columns: [t.bookId, t.genreId], foreignColumns: [bookGenres.bookId, bookGenres.genreId] }).onDelete('cascade'),
    index('book_genre_sources_book_source_idx').on(t.bookId, t.sourceKey),
  ],
);
export const tagMatchingExclusions = pgTable(
  'tag_matching_exclusions',
  {
    id: serial('id').primaryKey(),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id').references(() => tags.id, { onDelete: 'cascade' }),
    genreId: integer('genre_id').references(() => genres.id, { onDelete: 'cascade' }),
  },
  (t) => [
    check('tag_match_exclusion_one_chk', sql`num_nonnulls(${t.tagId},${t.genreId})=1`),
    uniqueIndex('tag_match_exclusion_tag_idx').on(t.bookId, t.tagId),
    uniqueIndex('tag_match_exclusion_genre_idx').on(t.bookId, t.genreId),
    index('tag_match_exclusion_user_idx').on(t.userId),
  ],
);
export const tagMatchingJobs = pgTable(
  'tag_matching_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rulebookId: integer('rulebook_id')
      .notNull()
      .references(() => tagRulebooks.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    state: varchar('state', { length: 20 }).$type<'previewing' | 'ready' | 'running' | 'completed' | 'failed'>().notNull().default('previewing'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    cursor: integer('cursor').notNull().default(0),
    processed: integer('processed').notNull().default(0),
    changed: integer('changed').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    error: varchar('error', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tag_match_job_owner_idx').on(t.userId, t.createdAt)],
);
export const tagMatchingJobItems = pgTable(
  'tag_matching_job_items',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => tagMatchingJobs.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    change: jsonb('change').$type<TagMatchingChange>().notNull(),
    overrideFields: jsonb('override_fields').$type<Array<'tags' | 'genres'>>().notNull().default([]),
    state: varchar('state', { length: 20 }).$type<'pending' | 'applied' | 'skipped'>().notNull().default('pending'),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.bookId] })],
);

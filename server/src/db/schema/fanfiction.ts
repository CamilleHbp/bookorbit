import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  EncryptedFanfictionDocument,
  FanfictionJob,
  FanfictionJobKind,
  FanfictionJobState,
  FanfictionSourceState,
  FanfictionImportRequest,
} from '@bookorbit/types';
import { libraries, libraryFolders } from './libraries';
import { users } from './auth';
import { books, bookFiles } from './books';

export const fanfictionProfiles = pgTable(
  'fanfiction_profiles',
  {
    id: uuid('id').primaryKey(),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 120 }).notNull(),
    document: jsonb('document').$type<EncryptedFanfictionDocument>().notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('fanfiction_profiles_library_id_idx').on(t.libraryId, t.id), index('fanfiction_profiles_created_by_idx').on(t.createdBy)],
);

export const fanfictionSources = pgTable(
  'fanfiction_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    folderId: integer('folder_id').references(() => libraryFolders.id, { onDelete: 'set null' }),
    profileId: uuid('profile_id').references(() => fanfictionProfiles.id, { onDelete: 'restrict' }),
    bookId: integer('book_id').references(() => books.id, { onDelete: 'cascade' }),
    bookFileId: integer('book_file_id').references(() => bookFiles.id, { onDelete: 'cascade' }),
    canonicalUrl: text('canonical_url').notNull(),
    canonicalKey: varchar('canonical_key', { length: 64 }).notNull(),
    site: varchar('site', { length: 255 }).notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    authors: jsonb('authors').$type<string[]>().notNull().default([]),
    state: varchar('state', { length: 30 }).$type<FanfictionSourceState>().notNull().default('pending'),
    chapterCount: integer('chapter_count').notNull().default(0),
    wordCount: integer('word_count'),
    storyStatus: varchar('story_status', { length: 100 }).notNull().default(''),
    intervalMinutes: integer('interval_minutes').default(1440),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }),
    attentionCode: varchar('attention_code', { length: 100 }),
    importOperationId: uuid('import_operation_id').notNull().unique(),
    relativePath: text('relative_path').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('fanfiction_sources_identity_idx').on(t.libraryId, t.canonicalKey),
    uniqueIndex('fanfiction_sources_file_idx')
      .on(t.bookFileId)
      .where(sql`${t.state} <> 'unlinked'`),
    index('fanfiction_sources_list_idx').on(t.libraryId, t.createdAt, t.id),
    index('fanfiction_sources_schedule_idx').on(t.state, t.nextCheckAt, t.id),
    index('fanfiction_sources_user_idx').on(t.createdBy),
    index('fanfiction_sources_folder_idx').on(t.folderId),
    index('fanfiction_sources_profile_idx').on(t.profileId),
    index('fanfiction_sources_book_idx').on(t.bookId),
    check('fanfiction_sources_state_chk', sql`${t.state} in ('pending', 'active', 'paused', 'review_required', 'configuration_blocked', 'unlinked')`),
    check('fanfiction_sources_interval_chk', sql`${t.intervalMinutes} is null or ${t.intervalMinutes} >= 60`),
    check('fanfiction_sources_chapters_chk', sql`${t.chapterCount} >= 0 and (${t.wordCount} is null or ${t.wordCount} >= 0)`),
  ],
);

export const fanfictionJobs = pgTable(
  'fanfiction_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenVersion: integer('token_version').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    profileId: uuid('profile_id').references(() => fanfictionProfiles.id, { onDelete: 'restrict' }),
    sourceId: uuid('source_id').references(() => fanfictionSources.id, { onDelete: 'set null' }),
    input: jsonb('input').$type<FanfictionImportRequest>(),
    kind: varchar('kind', { length: 20 }).$type<FanfictionJobKind>().notNull(),
    state: varchar('state', { length: 30 }).$type<FanfictionJobState>().notNull().default('queued'),
    url: text('url').notNull(),
    site: varchar('site', { length: 255 }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    fence: integer('fence').notNull().default(0),
    leaseOwner: uuid('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    cancellationRequested: boolean('cancellation_requested').notNull().default(false),
    result: jsonb('result').$type<FanfictionJob['result']>(),
    errorCode: varchar('error_code', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('fanfiction_jobs_request_idx').on(t.libraryId, t.userId, t.idempotencyKey),
    index('fanfiction_jobs_queue_idx').on(t.state, t.runAfter, t.id),
    index('fanfiction_jobs_lease_idx').on(t.state, t.leaseExpiresAt),
    index('fanfiction_jobs_library_created_idx').on(t.libraryId, t.createdAt, t.id),
    index('fanfiction_jobs_user_idx').on(t.userId),
    index('fanfiction_jobs_profile_idx').on(t.profileId),
    uniqueIndex('fanfiction_jobs_active_source_idx')
      .on(t.sourceId)
      .where(sql`${t.sourceId} is not null and ${t.state} in ('queued', 'running')`),
    index('fanfiction_jobs_source_idx').on(t.sourceId),
    check('fanfiction_jobs_attempts_chk', sql`${t.attempts} >= 0 and ${t.fence} >= 0`),
    check('fanfiction_jobs_kind_chk', sql`${t.kind} in ('preview', 'discovery', 'import', 'update', 'refresh', 'rollback')`),
    check(
      'fanfiction_jobs_state_chk',
      sql`${t.state} in ('queued', 'running', 'succeeded', 'no_change', 'review_required', 'configuration_blocked', 'failed', 'cancelled')`,
    ),
  ],
);

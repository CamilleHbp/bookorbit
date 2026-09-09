import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  EncryptedFanfictionDocument,
  FanfictionJob,
  FanfictionJobKind,
  FanfictionJobState,
  FanfictionSourceState,
  FanfictionImportRequest,
  FanfictionActivity,
  FanfictionDiscoveryProgress,
  FanfictionDiscoverySelection,
  FanfictionCandidateState,
  FanfictionRecognizedUrl,
  FanfictionSourceSelection,
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
    credentialGeneration: integer('credential_generation').notNull().default(1),
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
    index('fanfiction_sources_batch_idx').on(t.libraryId, t.id),
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
    sourceVersion: integer('source_version'),
    expectedRevisionId: uuid('expected_revision_id'),
    rollbackRevisionId: uuid('rollback_revision_id'),
    replacementUploadId: uuid('replacement_upload_id'),
    replacementSha256: varchar('replacement_sha256', { length: 64 }),
    replacementReductionApproved: boolean('replacement_reduction_approved').notNull().default(false),
    scheduled: boolean('scheduled').notNull().default(false),
    kind: varchar('kind', { length: 20 }).$type<FanfictionJobKind>().notNull(),
    discovery: jsonb('discovery').$type<FanfictionDiscoveryProgress>(),
    selection: jsonb('selection').$type<FanfictionDiscoverySelection>(),
    sourceSelection: jsonb('source_selection').$type<FanfictionSourceSelection>(),
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
    index('fanfiction_jobs_library_kind_created_idx').on(t.libraryId, t.kind, t.createdAt, t.id),
    index('fanfiction_jobs_library_kind_active_idx')
      .on(t.libraryId, t.kind, t.createdAt, t.id)
      .where(sql`${t.state} in ('queued', 'running')`),
    index('fanfiction_jobs_user_idx').on(t.userId),
    index('fanfiction_jobs_profile_idx').on(t.profileId),
    uniqueIndex('fanfiction_jobs_active_source_idx')
      .on(t.sourceId)
      .where(sql`${t.sourceId} is not null and ${t.state} in ('queued', 'running')`),
    index('fanfiction_jobs_source_idx').on(t.sourceId),
    check('fanfiction_jobs_attempts_chk', sql`${t.attempts} >= 0 and ${t.fence} >= 0`),
    check(
      'fanfiction_jobs_kind_chk',
      sql`${t.kind} in ('preview', 'discovery', 'adopt', 'import', 'update', 'refresh', 'rollback', 'source_batch', 'replacement')`,
    ),
    uniqueIndex('fanfiction_jobs_discovery_active_idx')
      .on(t.libraryId)
      .where(sql`${t.kind} = 'discovery' and ${t.state} in ('queued', 'running')`),
    check(
      'fanfiction_jobs_state_chk',
      sql`${t.state} in ('queued', 'running', 'succeeded', 'no_change', 'review_required', 'configuration_blocked', 'failed', 'cancelled')`,
    ),
  ],
);

export const fanfictionSourceBatchFailures = pgTable(
  'fanfiction_source_batch_failures',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => fanfictionJobs.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => fanfictionSources.id, { onDelete: 'cascade' }),
    errorCode: varchar('error_code', { length: 100 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.sourceId] }), index('fanfiction_source_batch_failures_source_idx').on(t.sourceId)],
);

export const fanfictionDiscoveryCandidates = pgTable(
  'fanfiction_discovery_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    bookFileId: integer('book_file_id')
      .notNull()
      .references(() => bookFiles.id, { onDelete: 'cascade' }),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    authors: jsonb('authors').$type<string[]>().notNull().default([]),
    chapterCount: integer('chapter_count').notNull(),
    urls: jsonb('urls').$type<FanfictionRecognizedUrl[]>().notNull(),
    state: varchar('state', { length: 20 }).$type<FanfictionCandidateState>().notNull(),
    errorCode: varchar('error_code', { length: 100 }),
    sourceId: uuid('source_id').references(() => fanfictionSources.id, { onDelete: 'set null' }),
    reviewJobId: uuid('review_job_id').references(() => fanfictionJobs.id, { onDelete: 'set null' }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('fanfiction_candidates_file_revision_idx').on(t.libraryId, t.bookFileId, t.sha256),
    index('fanfiction_candidates_review_idx').on(t.libraryId, t.state, t.id),
    index('fanfiction_candidates_book_idx').on(t.bookId),
    index('fanfiction_candidates_file_idx').on(t.bookFileId),
    index('fanfiction_candidates_source_idx').on(t.sourceId),
    index('fanfiction_candidates_review_job_idx').on(t.reviewJobId, t.state, t.id),
    check('fanfiction_candidates_state_chk', sql`${t.state} in ('pending', 'ambiguous', 'rejected', 'linked', 'failed')`),
    check('fanfiction_candidates_chapters_chk', sql`${t.chapterCount} >= 0 and ${t.chapterCount} <= 10000`),
  ],
);

export const fanfictionActivity = pgTable(
  'fanfiction_activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => fanfictionSources.id, { onDelete: 'set null' }),
    jobId: uuid('job_id').references(() => fanfictionJobs.id, { onDelete: 'set null' }),
    eventKey: varchar('event_key', { length: 100 }).notNull().unique(),
    kind: varchar('kind', { length: 20 }).$type<FanfictionActivity['kind']>().notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
    revisionId: uuid('revision_id'),
    errorCode: varchar('error_code', { length: 100 }),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    notificationAttempts: integer('notification_attempts').notNull().default(0),
    notificationRunAfter: timestamp('notification_run_after', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('fanfiction_activity_library_idx').on(t.libraryId, t.createdAt, t.id),
    index('fanfiction_activity_pending_idx')
      .on(t.notificationRunAfter, t.id)
      .where(sql`${t.notifiedAt} is null`),
    index('fanfiction_activity_user_idx').on(t.userId),
    index('fanfiction_activity_source_idx').on(t.sourceId),
    index('fanfiction_activity_job_idx').on(t.jobId),
    index('fanfiction_activity_book_idx').on(t.bookId),
    check('fanfiction_activity_kind_chk', sql`${t.kind} in ('imported', 'updated', 'rolled_back', 'attention', 'failed', 'batch_completed')`),
  ],
);

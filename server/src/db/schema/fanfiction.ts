import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { EncryptedFanfictionDocument, FanfictionJob, FanfictionJobKind, FanfictionJobState } from '@bookorbit/types';
import { libraries } from './libraries';
import { users } from './auth';

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
    check('fanfiction_jobs_attempts_chk', sql`${t.attempts} >= 0 and ${t.fence} >= 0`),
    check('fanfiction_jobs_kind_chk', sql`${t.kind} in ('preview', 'discovery', 'import', 'update', 'refresh', 'rollback')`),
    check(
      'fanfiction_jobs_state_chk',
      sql`${t.state} in ('queued', 'running', 'succeeded', 'no_change', 'review_required', 'configuration_blocked', 'failed', 'cancelled')`,
    ),
  ],
);

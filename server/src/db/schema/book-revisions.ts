import { bigint, check, index, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  BookRevisionChangeKind,
  BookRevisionReason,
  EpubRevisionManifest,
  RevisionChapter,
  RevisionPublicationReason,
  RevisionPublicationState,
} from '@bookorbit/types';
import { bookFiles } from './books';
import { libraries } from './libraries';

export const bookFileRevisions = pgTable(
  'book_file_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookFileId: integer('book_file_id')
      .notNull()
      .references(() => bookFiles.id, { onDelete: 'cascade' }),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    fileHash: varchar('file_hash', { length: 32 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    reason: varchar('reason', { length: 30 }).$type<BookRevisionReason>().notNull(),
    chapters: jsonb('chapters').$type<RevisionChapter[]>(),
    manifestVersion: integer('manifest_version'),
    contentHash: varchar('content_hash', { length: 64 }),
    metadataHash: varchar('metadata_hash', { length: 64 }),
    coverHash: varchar('cover_hash', { length: 64 }),
    changeKind: varchar('change_kind', { length: 20 }).$type<BookRevisionChangeKind>().notNull().default('unknown'),
    storagePath: varchar('storage_path', { length: 4096 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('book_file_revisions_file_created_idx').on(t.bookFileId, t.createdAt, t.id),
    index('book_file_revisions_file_sha256_idx').on(t.bookFileId, t.sha256),
    check('book_file_revisions_size_chk', sql`${t.sizeBytes} >= 0`),
    check('book_file_revisions_reason_chk', sql`${t.reason} in ('baseline', 'external_change', 'file_write', 'fanficfare', 'rollback')`),
  ],
);

export const revisionPublications = pgTable(
  'revision_publications',
  {
    id: uuid('id').primaryKey(),
    bookFileId: integer('book_file_id')
      .notNull()
      .references(() => bookFiles.id, { onDelete: 'cascade' }),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    expectedRevisionId: uuid('expected_revision_id').notNull(),
    nextRevisionId: uuid('next_revision_id').notNull(),
    targetPath: varchar('target_path', { length: 4096 }).notNull(),
    stagedPath: varchar('staged_path', { length: 4096 }).notNull(),
    backupPath: varchar('backup_path', { length: 4096 }).notNull(),
    previousSha256: varchar('previous_sha256', { length: 64 }).notNull(),
    nextSha256: varchar('next_sha256', { length: 64 }).notNull(),
    nextFileHash: varchar('next_file_hash', { length: 32 }).notNull(),
    nextSizeBytes: bigint('next_size_bytes', { mode: 'number' }).notNull(),
    manifest: jsonb('manifest').$type<EpubRevisionManifest>().notNull(),
    reason: varchar('reason', { length: 30 }).$type<RevisionPublicationReason>().notNull(),
    ownerKey: uuid('owner_key'),
    state: varchar('state', { length: 30 }).$type<RevisionPublicationState>().notNull().default('prepared'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('revision_publications_owner_idx').on(t.ownerKey),
    uniqueIndex('revision_publications_active_file_idx')
      .on(t.bookFileId)
      .where(sql`${t.state} in ('prepared', 'filesystem_published')`),
    index('revision_publications_recovery_idx').on(t.state, t.createdAt, t.id),
    index('revision_publications_library_file_idx').on(t.libraryId, t.bookFileId, t.createdAt),
    check(
      'revision_publications_state_chk',
      sql`${t.state} in ('prepared', 'filesystem_published', 'database_committed', 'cleanup_complete', 'failed')`,
    ),
    check('revision_publications_reason_chk', sql`${t.reason} in ('fanficfare', 'rollback')`),
    check('revision_publications_size_chk', sql`${t.nextSizeBytes} >= 0`),
  ],
);

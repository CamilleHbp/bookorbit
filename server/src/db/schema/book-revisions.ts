import { bigint, check, index, integer, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { RevisionChapter } from '@bookorbit/types';
import { bookFiles } from './books';

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
    reason: varchar('reason', { length: 30 }).notNull(),
    chapters: jsonb('chapters').$type<RevisionChapter[]>(),
    manifestVersion: integer('manifest_version'),
    contentHash: varchar('content_hash', { length: 64 }),
    metadataHash: varchar('metadata_hash', { length: 64 }),
    coverHash: varchar('cover_hash', { length: 64 }),
    changeKind: varchar('change_kind', { length: 20 }).notNull().default('unknown'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('book_file_revisions_file_created_idx').on(t.bookFileId, t.createdAt, t.id),
    index('book_file_revisions_file_sha256_idx').on(t.bookFileId, t.sha256),
    check('book_file_revisions_size_chk', sql`${t.sizeBytes} >= 0`),
    check('book_file_revisions_reason_chk', sql`${t.reason} in ('baseline', 'external_change', 'file_write', 'fanficfare', 'rollback')`),
  ],
);

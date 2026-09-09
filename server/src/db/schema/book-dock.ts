import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, serial, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import type { BookDockMetadata } from '@bookorbit/types';

import { libraries, libraryFolders } from './libraries';
import { users } from './auth';
import { books, bookFiles } from './books';

export const bookDockFiles = pgTable(
  'book_dock_files',
  {
    id: serial('id').primaryKey(),
    fileName: varchar('file_name', { length: 500 }).notNull(),
    absolutePath: text('absolute_path').notNull().unique(),
    fileSize: bigint('file_size', { mode: 'number' }),
    format: varchar('format', { length: 20 }),
    /**
     * Set when this row owns a directory of files rather than a single loose one. The row's own
     * `absolutePath`, `format` and `fileSize` keep describing the unit's **primary** file, because
     * metadata and cover extraction on a 31-track audiobook should read exactly one of them.
     *
     * Null is today's loose single file, which is why existing rows need no migration. Non-null
     * also means the watcher must not descend into that directory: the row claimed it before it
     * existed on disk, precisely so the watcher cannot win the race.
     *
     * Always exactly one level below the dock root, which is what keeps the watcher's claim check
     * an equality lookup rather than an ancestor walk.
     */
    unitDirectory: text('unit_directory').unique(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    embeddedMetadata: jsonb('embedded_metadata').$type<BookDockMetadata>(),
    selectedMetadata: jsonb('selected_metadata').$type<BookDockMetadata>(),
    fetchedMetadata: jsonb('fetched_metadata').$type<BookDockMetadata>(),
    coverPath: text('cover_path'),
    targetLibraryId: integer('target_library_id').references(() => libraries.id, { onDelete: 'set null' }),
    targetFolderId: integer('target_folder_id').references(() => libraryFolders.id, { onDelete: 'set null' }),
    confidence: integer('confidence'),
    fetchedMetadataSources: jsonb('fetched_metadata_sources').$type<Partial<Record<keyof BookDockMetadata, string>>>(),
    errorMessage: text('error_message'),
    metadataEditedAt: timestamp('metadata_edited_at', { withTimezone: true }),
    uploadedBy: integer('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Another module owns finalization for this row and will call it explicitly once its own
     * checks pass. Generic auto-finalize skips it so the two paths never race for the same file.
     * The dock deliberately does not learn which module, only that it is not its call to make.
     */
    autoFinalizeSuppressed: boolean('auto_finalize_suppressed').notNull().default(false),
    ingestionMode: varchar('ingestion_mode', { length: 20 }).notNull().default('standard'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('book_dock_files_status_idx').on(t.status),
    index('book_dock_files_target_library_id_idx').on(t.targetLibraryId),
    index('book_dock_files_uploaded_by_idx').on(t.uploadedBy),
    check('book_dock_files_status_chk', sql`${t.status} in ('pending', 'extracting', 'fetching', 'ready', 'error')`),
    check('book_dock_files_ingestion_mode_chk', sql`${t.ingestionMode} in ('standard', 'managed')`),
    check('book_dock_files_confidence_range_chk', sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 100)`),
  ],
);

export type BookDockFileRow = typeof bookDockFiles.$inferSelect;
export type NewBookDockFileRow = typeof bookDockFiles.$inferInsert;

export const bookDockManagedUploads = pgTable(
  'book_dock_managed_uploads',
  {
    id: uuid('id').primaryKey(),
    dockFileId: integer('dock_file_id').references(() => bookDockFiles.id, { onDelete: 'set null' }),
    libraryId: integer('library_id').references(() => libraries.id, { onDelete: 'set null' }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    ownerKey: uuid('owner_key'),
    state: varchar('state', { length: 20 }).$type<'uploading' | 'ready' | 'claimed'>().notNull().default('uploading'),
    sha256: varchar('sha256', { length: 64 }),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('book_dock_managed_uploads_expiry_idx').on(t.expiresAt, t.id),
    index('book_dock_managed_uploads_user_idx').on(t.userId),
    index('book_dock_managed_uploads_library_idx').on(t.libraryId),
    index('book_dock_managed_uploads_dock_idx').on(t.dockFileId),
    check('book_dock_managed_uploads_state_chk', sql`${t.state} in ('uploading', 'ready', 'claimed')`),
    check('book_dock_managed_uploads_size_chk', sql`${t.sizeBytes} >= 0 and ${t.sizeBytes} <= 134217728`),
    check('book_dock_managed_uploads_hash_chk', sql`${t.sha256} is null or ${t.sha256} ~ '^[a-f0-9]{64}$'`),
  ],
);

/**
 * The files a dock unit is made of, in playback or format order. Holds **every** file including
 * the primary, so the primary's path appears here and on the anchor row too. That duplication is
 * the cheaper half of the trade: placement, rollback, discard and delete iterate one list rather
 * than a union, and the anchor stays a plain "which file do I read metadata from" pointer.
 */
export const bookDockUnitFiles = pgTable(
  'book_dock_unit_files',
  {
    id: serial('id').primaryKey(),
    dockFileId: integer('dock_file_id')
      .notNull()
      .references(() => bookDockFiles.id, { onDelete: 'cascade' }),
    absolutePath: text('absolute_path').notNull().unique(),
    fileName: varchar('file_name', { length: 500 }).notNull(),
    fileSize: bigint('file_size', { mode: 'number' }),
    format: varchar('format', { length: 20 }),
    role: varchar('role', { length: 20 }).notNull().default('content'),
    /** Content files only. Natural order within the unit, so track 10 follows track 9. */
    sortOrder: integer('sort_order'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('book_dock_unit_files_dock_file_id_sort_order_idx').on(t.dockFileId, t.sortOrder),
    check('book_dock_unit_files_role_chk', sql`${t.role} in ('content', 'cover', 'metadata', 'supplement')`),
  ],
);

export type BookDockUnitFileRow = typeof bookDockUnitFiles.$inferSelect;
export type NewBookDockUnitFileRow = typeof bookDockUnitFiles.$inferInsert;

export const bookDockManagedImports = pgTable(
  'book_dock_managed_imports',
  {
    id: uuid('id').primaryKey(),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    folderId: integer('folder_id')
      .notNull()
      .references(() => libraryFolders.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dockFileId: integer('dock_file_id').notNull().unique(),
    metadataSourceKey: varchar('metadata_source_key', { length: 100 }),
    state: varchar('state', { length: 32 })
      .$type<'reserved' | 'prepared' | 'filesystem_published' | 'database_committed' | 'metadata_committed' | 'cleanup_complete'>()
      .notNull()
      .default('reserved'),
    fileName: text('file_name').notNull(),
    sourcePath: text('source_path').notNull(),
    dockPath: text('dock_path').notNull(),
    libraryRoot: text('library_root').notNull(),
    destinationPath: text('destination_path').notNull().unique(),
    bookFolderPath: text('book_folder_path').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
    bookFileId: integer('book_file_id').references(() => bookFiles.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('book_dock_managed_imports_library_idx').on(t.libraryId, t.id),
    index('book_dock_managed_imports_folder_idx').on(t.folderId),
    index('book_dock_managed_imports_user_idx').on(t.userId),
    index('book_dock_managed_imports_book_idx').on(t.bookId),
    index('book_dock_managed_imports_file_idx').on(t.bookFileId),
    check(
      'book_dock_managed_imports_state_chk',
      sql`${t.state} in ('reserved', 'prepared', 'filesystem_published', 'database_committed', 'metadata_committed', 'cleanup_complete')`,
    ),
  ],
);

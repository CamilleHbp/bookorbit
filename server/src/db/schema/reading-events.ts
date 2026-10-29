import { bigint, check, index, integer, jsonb, pgTable, primaryKey, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { ReadingAnchor, RevisionPositionAcknowledgement } from '@bookorbit/types';
import { users } from './auth';
import { bookFiles } from './books';

export const canonicalReadingEvents = pgTable(
  'canonical_reading_events',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookFileId: integer('book_file_id')
      .notNull()
      .references(() => bookFiles.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull(),
    deviceId: varchar('device_id', { length: 128 }).notNull(),
    deviceSequence: bigint('device_sequence', { mode: 'number' }).notNull(),
    resetGeneration: bigint('reset_generation', { mode: 'number' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 3 }).notNull(),
    anchor: jsonb('anchor').$type<ReadingAnchor>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.bookFileId, t.id] }),
    index('canonical_reading_events_file_idx').on(t.bookFileId),
    uniqueIndex('canonical_reading_events_device_sequence_idx').on(t.userId, t.bookFileId, t.deviceId, t.resetGeneration, t.deviceSequence),
    check('canonical_reading_events_sequence_chk', sql`${t.deviceSequence} >= 0 and ${t.deviceSequence} <= 9007199254740991`),
    check('canonical_reading_events_generation_chk', sql`${t.resetGeneration} >= 0 and ${t.resetGeneration} <= 9007199254740991`),
  ],
);

export const readingEventHeads = pgTable(
  'reading_event_heads',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookFileId: integer('book_file_id')
      .notNull()
      .references(() => bookFiles.id, { onDelete: 'cascade' }),
    resetGeneration: bigint('reset_generation', { mode: 'number' }).notNull().default(0),
    eventId: uuid('event_id'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.bookFileId] }),
    index('reading_event_heads_file_idx').on(t.bookFileId),
    check('reading_event_heads_generation_chk', sql`${t.resetGeneration} >= 0 and ${t.resetGeneration} <= 9007199254740991`),
  ],
);

export const readingPositionAcknowledgements = pgTable(
  'reading_position_acknowledgements',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookFileId: integer('book_file_id')
      .notNull()
      .references(() => bookFiles.id, { onDelete: 'cascade' }),
    deviceId: varchar('device_id', { length: 128 }).notNull(),
    copyId: uuid('copy_id').notNull(),
    acknowledgement: jsonb('acknowledgement').$type<RevisionPositionAcknowledgement>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.bookFileId, t.deviceId, t.copyId] }),
    index('reading_position_acknowledgements_file_idx').on(t.bookFileId),
  ],
);

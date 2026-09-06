import { bigint, check, foreignKey, index, integer, pgTable, primaryKey, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { KoreaderDeliveryPolicy } from '@bookorbit/types';
import { users } from './auth';
import { bookFiles } from './books';
import { bookFileRevisions } from './book-revisions';

export const koreaderDeliveryDevices = pgTable(
  'koreader_delivery_devices',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: varchar('device_id', { length: 100 }).notNull(),
    pluginVersion: varchar('plugin_version', { length: 64 }).notNull(),
    contactSequence: bigint('contact_sequence', { mode: 'number' }).notNull().default(0),
    deliveryCapabilityVersion: integer('delivery_capability_version').notNull().default(0),
    positionCapabilityVersion: integer('position_capability_version').notNull().default(0),
    policy: varchar('policy', { length: 20 }).$type<KoreaderDeliveryPolicy>().notNull().default('notify'),
    policyVersion: integer('policy_version').notNull().default(1),
    lastContactAt: timestamp('last_contact_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.deviceId] }),
    check('koreader_delivery_devices_policy_chk', sql`${t.policy} in ('notify', 'automatic', 'ignore')`),
    check(
      'koreader_delivery_devices_versions_chk',
      sql`${t.policyVersion} > 0 and ${t.contactSequence} >= 0 and ${t.deliveryCapabilityVersion} >= 0 and ${t.positionCapabilityVersion} >= 0`,
    ),
  ],
);

export const koreaderInstalledCopies = pgTable(
  'koreader_installed_copies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: varchar('device_id', { length: 100 }).notNull(),
    copyId: uuid('copy_id').notNull(),
    bookFileId: integer('book_file_id')
      .notNull()
      .references(() => bookFiles.id, { onDelete: 'cascade' }),
    pathname: varchar('pathname', { length: 4096 }).notNull(),
    pathnameHash: varchar('pathname_hash', { length: 64 }).notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    revisionId: uuid('revision_id').references(() => bookFileRevisions.id, { onDelete: 'set null' }),
    reportSequence: bigint('report_sequence', { mode: 'number' }).notNull(),
    reportHash: varchar('report_hash', { length: 64 }).notNull(),
    policy: varchar('policy', { length: 20 }).$type<KoreaderDeliveryPolicy>(),
    policyVersion: integer('policy_version').notNull().default(1),
    policyAcknowledgement: varchar('policy_acknowledgement', { length: 50 }),
    lastContactAt: timestamp('last_contact_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.deviceId],
      foreignColumns: [koreaderDeliveryDevices.userId, koreaderDeliveryDevices.deviceId],
      name: 'koreader_copies_device_fk',
    }).onDelete('cascade'),
    uniqueIndex('koreader_copies_identity_idx').on(t.userId, t.deviceId, t.copyId),
    uniqueIndex('koreader_copies_path_idx').on(t.userId, t.deviceId, t.pathnameHash),
    index('koreader_copies_user_page_idx').on(t.userId, t.id),
    index('koreader_copies_device_page_idx').on(t.userId, t.deviceId, t.id),
    index('koreader_copies_user_file_idx').on(t.userId, t.bookFileId, t.id),
    index('koreader_copies_file_idx').on(t.bookFileId),
    index('koreader_copies_revision_idx').on(t.revisionId),
    check('koreader_copies_policy_chk', sql`${t.policy} is null or ${t.policy} in ('notify', 'automatic', 'ignore')`),
    check(
      'koreader_copies_values_chk',
      sql`${t.policyVersion} > 0 and ${t.reportSequence} > 0 and ${t.sizeBytes} >= 0 and ${t.sha256} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

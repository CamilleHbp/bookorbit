import { bigint, check, foreignKey, index, integer, pgTable, primaryKey, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { KoreaderDeliveryPolicy, KoreaderInstallationState, KoreaderRestorationState, KoreaderDeliveryFailure } from '@bookorbit/types';
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

export const koreaderDeliveryJobs = pgTable(
  'koreader_delivery_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    installedCopyId: uuid('installed_copy_id')
      .notNull()
      .references(() => koreaderInstalledCopies.id, { onDelete: 'cascade' }),
    libraryId: integer('library_id').notNull(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => bookFileRevisions.id, { onDelete: 'cascade' }),
    requestKey: uuid('request_key').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    expectedLocalSha256: varchar('expected_local_sha256', { length: 64 }).notNull(),
    expectedLocalSizeBytes: bigint('expected_local_size_bytes', { mode: 'number' }).notNull(),
    pathname: varchar('pathname', { length: 4096 }).notNull(),
    mode: varchar('mode', { length: 12 }).$type<'manual' | 'automatic'>().notNull(),
    installationState: varchar('installation_state', { length: 30 }).$type<KoreaderInstallationState>().notNull().default('requested'),
    restorationState: varchar('restoration_state', { length: 30 }).$type<KoreaderRestorationState>().notNull().default('verification_pending'),
    failureCode: varchar('failure_code', { length: 40 }).$type<KoreaderDeliveryFailure>(),
    restorationFailureCode: varchar('restoration_failure_code', { length: 80 }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    attempt: integer('attempt').notNull().default(1),
    fence: integer('fence').notNull().default(0),
    leaseToken: uuid('lease_token'),
    claimId: uuid('claim_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    reportSequence: bigint('report_sequence', { mode: 'number' }).notNull().default(0),
    reportHash: varchar('report_hash', { length: 64 }),
    publicationToken: uuid('publication_token'),
    publicationExpiresAt: timestamp('publication_expires_at', { withTimezone: true }),
    installedAt: timestamp('installed_at', { withTimezone: true }),
    restoredAt: timestamp('restored_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('koreader_delivery_revision_idx').on(t.userId, t.installedCopyId, t.revisionId),
    uniqueIndex('koreader_delivery_request_idx').on(t.userId, t.requestKey),
    uniqueIndex('koreader_delivery_active_copy_idx')
      .on(t.installedCopyId)
      .where(sql`${t.cancelledAt} is null and ${t.failureCode} is null and ${t.installationState} <> 'installed'`),
    index('koreader_delivery_user_page_idx').on(t.userId, t.createdAt.desc(), t.id.desc()),
    index('koreader_delivery_copy_page_idx').on(t.installedCopyId, t.createdAt.desc(), t.id.desc()),
    index('koreader_delivery_copy_restoration_idx')
      .on(t.installedCopyId, t.installedAt.desc(), t.id.desc())
      .where(sql`${t.installationState} = 'installed'`),
    index('koreader_delivery_revision_fk_idx').on(t.revisionId),
    check(
      'koreader_delivery_installation_chk',
      sql`${t.installationState} in ('requested', 'waiting_for_uploads', 'waiting_for_close', 'downloading', 'installed')`,
    ),
    check('koreader_delivery_restoration_chk', sql`${t.restorationState} in ('verification_pending', 'verified', 'approximate', 'failed')`),
    check('koreader_delivery_mode_chk', sql`${t.mode} in ('manual', 'automatic')`),
    check(
      'koreader_delivery_identity_chk',
      sql`${t.sha256} ~ '^[a-f0-9]{64}$' and ${t.expectedLocalSha256} ~ '^[a-f0-9]{64}$' and ${t.sizeBytes} >= 0 and ${t.expectedLocalSizeBytes} >= 0`,
    ),
    check('koreader_delivery_counter_chk', sql`${t.version} > 0 and ${t.attempt} > 0 and ${t.fence} >= 0 and ${t.reportSequence} >= 0`),
  ],
);

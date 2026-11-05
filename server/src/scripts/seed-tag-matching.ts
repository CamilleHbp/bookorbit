import { backfillMatchingSnapshots } from '../modules/tag-matching/tag-matching-backfill';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { FanfictionConnectionDocument } from '@bookorbit/types';
import { storageConfig, fanficfareConfig } from '../config/config';
import { FanfictionVaultService } from '../modules/fanfiction/fanfiction-vault.service';
import { TagMatchingService } from '../modules/tag-matching/tag-matching.service';
import { sanitizeLogValue } from '../common/utils/log-sanitize.utils';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../db/schema';
import { createPostgresClientConfig } from '../db/postgres-connection-config';
import { importMatchingSeed } from '../modules/tag-matching/tag-matching-seed';

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      user: { type: 'string' },
      libraries: { type: 'string' },
      'replace-ignored-fandoms': { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      legacy: { type: 'boolean', default: false },
      snapshots: { type: 'boolean', default: false },
    },
  });
  const userId = Number(values.user);
  const libraryIds = values.libraries?.split(',').map(Number) ?? [];
  if (!values.file || !Number.isSafeInteger(userId) || userId < 1 || !process.env.DATABASE_URL)
    throw new Error('Provide --file, --user <account ID>, --libraries <IDs> and DATABASE_URL. Add --apply after validating the dry run.');
  const data: unknown = JSON.parse(await readFile(values.file, 'utf8'));
  const pool = new Pool(createPostgresClientConfig(process.env.DATABASE_URL, { max: 1, connectionTimeoutMillis: 5000 }));
  const startedAt = Date.now();
  console.log(`[tag_matching_seed] [start] userId=${userId} libraries=${libraryIds.length} apply=${values.apply} - validating personal matches`);
  try {
    const db = drizzle(pool, { schema });
    const result = await importMatchingSeed(db, userId, libraryIds, data, values.apply, values['replace-ignored-fandoms']);
    let legacyRules = 0;
    if (values.legacy) {
      const vault = new FanfictionVaultService(storageConfig(), fanficfareConfig());
      const matching = new TagMatchingService(db);
      const [actor] = await db
        .select({ id: schema.users.id, active: schema.users.active, isSuperuser: schema.users.isSuperuser })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      if (!actor?.active || !actor.isSuperuser) throw new Error('Seed account is no longer authorized');
      let cursor: string | undefined;
      while (true) {
        const rows = await db
          .select({ id: schema.fanfictionConnections.id })
          .from(schema.fanfictionConnections)
          .where(and(eq(schema.fanfictionConnections.userId, userId), cursor ? gt(schema.fanfictionConnections.id, cursor) : undefined))
          .orderBy(asc(schema.fanfictionConnections.id))
          .limit(100);
        for (const row of rows) {
          await db.transaction(async (tx) => {
            const [connection] = await tx
              .select()
              .from(schema.fanfictionConnections)
              .where(and(eq(schema.fanfictionConnections.id, row.id), eq(schema.fanfictionConnections.userId, userId)))
              .for('update');
            if (!connection) return;
            const document = JSON.parse(await vault.decrypt(`user:${userId}`, row.id, connection.document)) as FanfictionConnectionDocument;
            if (!document.tagRules?.length) return;
            legacyRules += document.tagRules.length;
            if (!values.apply) return;
            for (const source of new Set([connection.site, connection.site.startsWith('www.') ? connection.site.slice(4) : `www.${connection.site}`]))
              await matching.importLegacyRules(tx, { ...actor, permissions: [] }, source, document.tagRules);
            const migrated = await vault.encrypt(`user:${userId}`, row.id, JSON.stringify({ ...document, tagRules: [] }), false);
            await tx.update(schema.fanfictionConnections).set({ document: migrated }).where(eq(schema.fanfictionConnections.id, row.id));
          });
        }
        if (rows.length < 100) break;
        cursor = rows.at(-1)!.id;
      }
    }
    const snapshots = values.snapshots ? await backfillMatchingSnapshots(db, userId, libraryIds, values.apply) : { examined: 0, inserted: 0 };
    console.log(
      `[tag_matching_seed] [end] userId=${userId} durationMs=${Date.now() - startedAt} inserted=${result.inserted} replaced=${result.replaced} retained=${result.retained} legacyRules=${legacyRules} snapshots=${snapshots.inserted} examined=${snapshots.examined} applied=${result.applied} version=${result.version} - seed processed`,
    );
  } catch (error) {
    console.error(
      `[tag_matching_seed] [fail] userId=${userId} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : 'Unknown failure')}" - seed failed`,
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
void main();

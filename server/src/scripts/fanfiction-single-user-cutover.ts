import { createDecipheriv, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import type { ConfigType } from '@nestjs/config';
import type { EncryptedFanfictionDocument, FanfictionConnectionDocument } from '@bookorbit/types';
import { fanficfareConfig, storageConfig } from '../config/config';
import { FanfictionVaultService } from '../modules/fanfiction/fanfiction-vault.service';
import { createPostgresClientConfig } from '../db/postgres-connection-config';

interface SavedProfile {
  id: string;
  library_id: number;
  created_by: number | null;
  document: EncryptedFanfictionDocument;
}
interface PreviousDocument extends FanfictionConnectionDocument {
  rootUrls?: string[];
}

export function connectionWebsite(document: PreviousDocument): string {
  const roots = document.rootUrls ?? [];
  const sites = new Set(roots.map((root) => new URL(root).hostname.replace(/^www\./, '')));
  if (sites.size !== 1) throw new Error('Each saved profile must identify exactly one website before this single-user cutover');
  return [...sites][0];
}

export async function convertFanfictionConnections(
  client: PoolClient,
  appDataPath: string,
  encryptionKey?: string,
): Promise<{ connections: number; stories: number; alreadyConverted: boolean }> {
  await client.query('BEGIN');
  try {
    const { rows: tables } = await client.query("select to_regclass('public.fanfiction_profiles') as profiles");
    if (!tables[0].profiles) {
      await client.query('COMMIT');
      return { connections: 0, stories: 0, alreadyConverted: true };
    }
    await client.query('LOCK TABLE fanfiction_profiles, fanfiction_connections, fanfiction_sources, fanfiction_jobs IN ACCESS EXCLUSIVE MODE');
    const { rows: users } = await client.query('select id, active from users order by id');
    if (users.length !== 1 || !users[0].active) throw new Error('This cutover requires exactly one active user');
    const userId = users[0].id as number;
    const { rows: running } = await client.query("select 1 from fanfiction_jobs where state = 'running' limit 1");
    if (running.length) throw new Error('Stop the application and finish or recover running jobs before the cutover');
    const { rows: profiles } = await client.query<SavedProfile>('select id, library_id, created_by, document from fanfiction_profiles order by id');
    const { rows: foreign } = await client.query(
      'select 1 from fanfiction_sources where created_by <> $1 or (maintainer_user_id is not null and maintainer_user_id <> $1) limit 1',
      [userId],
    );
    if (foreign.length || profiles.some((profile) => profile.created_by !== userId))
      throw new Error('All stories and profiles must belong to the sole user');
    const vault = new FanfictionVaultService(
      { appDataPath } as ConfigType<typeof storageConfig>,
      { encryptionKey } as ConfigType<typeof fanficfareConfig>,
    );
    const key = profiles.length
      ? encryptionKey
        ? { id: `operator-${createHash('sha256').update(Buffer.from(encryptionKey, 'base64')).digest('hex').slice(0, 32)}`, key: encryptionKey }
        : (JSON.parse(await readFile(join(appDataPath, 'fanfiction/keys/profile-key-v1.json'), 'utf8')) as { id: string; key: string })
      : null;
    const sites = new Map<string, string>();
    for (const profile of profiles) {
      const envelope = profile.document;
      if (!key || envelope.version !== 1 || envelope.keyId !== key.id) throw new Error('The saved profile encryption key does not match');
      const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key.key, 'base64'), Buffer.from(envelope.iv, 'base64'));
      cipher.setAAD(Buffer.from(JSON.stringify(['bookorbit-fanfiction-profile', 1, key.id, profile.library_id, profile.id])));
      cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const original = JSON.parse(
        Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]).toString('utf8'),
      ) as PreviousDocument;
      const site = connectionWebsite(original);
      if (sites.has(site)) throw new Error('Overlapping website profiles must be resolved before the cutover');
      sites.set(site, profile.id);
      const document: FanfictionConnectionDocument = {
        configuration: original.configuration,
        cookies: original.cookies,
        ...(original.tagRules ? { tagRules: original.tagRules } : {}),
      };
      const { rows: existing } = await client.query('select id, document from fanfiction_connections where user_id = $1 and site = $2', [
        userId,
        site,
      ]);
      if (existing.length) {
        const previous = JSON.parse(
          await vault.decrypt(`user:${userId}`, existing[0].id as string, existing[0].document as EncryptedFanfictionDocument),
        );
        if (
          existing[0].id !== profile.id ||
          JSON.stringify([previous.configuration, previous.cookies, previous.tagRules ?? []]) !==
            JSON.stringify([document.configuration, document.cookies, document.tagRules ?? []])
        )
          throw new Error('A personal connection already differs from the saved profile');
      } else {
        const encrypted = await vault.encrypt(`user:${userId}`, profile.id, JSON.stringify(document), false);
        await client.query(
          'insert into fanfiction_connections (id, user_id, site, document, has_password, cookie_count) values ($1, $2, $3, $4, $5, $6)',
          [profile.id, userId, site, encrypted, /^[ \t]*password[ \t]*[:=][ \t]*\S/m.test(document.configuration), document.cookies.length],
        );
      }
      await client.query(
        "update fanfiction_jobs set source_selection = (source_selection - 'repairProfileId' - 'repairRootUrls') || jsonb_build_object('repairConnectionSite', $1::text) where source_selection->>'repairProfileId' = $2",
        [site, profile.id],
      );
    }
    const stories = await client.query(
      "update fanfiction_sources set maintainer_user_id = coalesce(maintainer_user_id, created_by), updates_enabled = coalesce(updates_enabled, state <> 'paused'), access_mode = 'personal' where maintainer_user_id is null or updates_enabled is null or access_mode <> 'personal'",
    );
    await client.query(
      "update fanfiction_jobs set access_mode = 'personal', input = input - 'profileId' - 'accessMode', selection = case when selection is null then null else (selection - 'profileId' - 'autoProfile') || case when selection ? 'overrides' then jsonb_build_object('overrides', coalesce((select jsonb_agg(item - 'profileId') from jsonb_array_elements(selection->'overrides') item), '[]'::jsonb)) else '{}'::jsonb end end",
    );
    await client.query('COMMIT');
    return { connections: sites.size, stories: stories.rowCount ?? 0, alreadyConverted: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool(createPostgresClientConfig(process.env.DATABASE_URL, { max: 1 }));
  const client = await pool.connect();
  try {
    const result = await convertFanfictionConnections(client, process.env.APP_DATA_PATH ?? '/data', process.env.FANFICFARE_ENCRYPTION_KEY?.trim());
    console.log(
      `[fanfiction.cutover] [end] connections=${result.connections} stories=${result.stories} alreadyConverted=${result.alreadyConverted} - personal connections ready`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}
if (require.main === module)
  void main().catch(() => {
    console.error('[fanfiction.cutover] [fail] errorClass=CutoverError - conversion rejected; transaction rolled back');
    process.exitCode = 1;
  });

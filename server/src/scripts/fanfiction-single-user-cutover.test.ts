import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigType } from '@nestjs/config';
import type { EncryptedFanfictionDocument } from '@bookorbit/types';
import { storageConfig, fanficfareConfig } from '../config/config';
import { FanfictionVaultService } from '../modules/fanfiction/fanfiction-vault.service';
import { connectionWebsite, convertFanfictionConnections } from './fanfiction-single-user-cutover';

const key = Buffer.alloc(32, 7);
const encryptionKey = key.toString('base64');
const document = {
  rootUrls: ['https://archiveofourown.org', 'https://www.archiveofourown.org'],
  configuration: '[archiveofourown.org]\nusername: reader\npassword: private\ninclude_images: false',
  cookies: [{ name: 'session', value: 'private-cookie', domain: 'archiveofourown.org', path: '/', secure: true }],
  tagRules: [{ remoteTag: 'Fantasy', targetTag: 'My fantasy' }],
};
function fixture() {
  const id = randomUUID();
  const keyId = `operator-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(['bookorbit-fanfiction-profile', 1, keyId, 1, id])));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(document)), cipher.final()]);
  const envelope: EncryptedFanfictionDocument = {
    version: 1,
    keyId,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
  const state = {
    users: [{ id: 1, active: true }],
    running: false,
    profiles: [{ id, library_id: 1, created_by: 1, document: envelope }],
    converted: [] as { id: string; document: EncryptedFanfictionDocument }[],
  };
  const query = vi.fn((sql: string, values?: unknown[]) => {
    if (sql.startsWith('select to_regclass')) return { rows: [{ profiles: 'fanfiction_profiles' }] };
    if (sql.startsWith('select id, active')) return { rows: state.users };
    if (sql.startsWith('select 1 from fanfiction_jobs')) return { rows: state.running ? [{}] : [] };
    if (sql.startsWith('select id, library_id')) return { rows: state.profiles };
    if (sql.startsWith('select id, document')) return { rows: state.converted };
    if (sql.startsWith('insert into fanfiction_connections'))
      state.converted.push({ id: values![0] as string, document: values![3] as EncryptedFanfictionDocument });
    return { rows: [], rowCount: 4 };
  });
  return { state, query, client: { query } as unknown as PoolClient };
}

describe('single-user fanfiction cutover', () => {
  it('re-encrypts every setting under the owner and can safely run twice', async () => {
    const { state, query, client } = fixture();
    expect(await convertFanfictionConnections(client, '/unused', encryptionKey)).toMatchObject({ connections: 1, stories: 4 });
    const vault = new FanfictionVaultService(
      { appDataPath: '/unused' } as ConfigType<typeof storageConfig>,
      { encryptionKey } as ConfigType<typeof fanficfareConfig>,
    );
    const converted = state.converted[0];
    const restored = JSON.parse(await vault.decrypt('user:1', converted.id, converted.document));
    expect(restored).toEqual({ configuration: document.configuration, cookies: document.cookies, tagRules: document.tagRules });
    expect(JSON.stringify(converted.document)).not.toContain('private');
    await expect(vault.decrypt('user:2', converted.id, converted.document)).rejects.toThrow('authenticate');
    await convertFanfictionConnections(client, '/unused', encryptionKey);
    expect(state.converted).toHaveLength(1);
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(query.mock.calls.some(([sql]) => /set.*(interval_minutes|update_policy|tag_policy|book_id)/.test(sql))).toBe(false);
  });
  it.each(['users', 'running', 'owner', 'key', 'overlap'] as const)('rolls back when %s makes conversion unsafe', async (reason) => {
    const { state, query, client } = fixture();
    if (reason === 'users') state.users.push({ id: 2, active: true });
    if (reason === 'running') state.running = true;
    if (reason === 'owner') state.profiles[0].created_by = 2;
    if (reason === 'key') state.profiles[0].document.keyId = 'missing-key';
    if (reason === 'overlap') state.profiles.push(state.profiles[0]);
    await expect(convertFanfictionConnections(client, '/unused', encryptionKey)).rejects.toThrow();
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
  it('rejects multi-website profiles instead of silently discarding settings', () => {
    expect(() => connectionWebsite({ ...document, rootUrls: ['https://archiveofourown.org', 'https://fiction.live'] })).toThrow(
      'exactly one website',
    );
  });
});

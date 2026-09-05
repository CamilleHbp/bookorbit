import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storageConfig } from '../../config/config';
import { FanfictionVaultService } from './fanfiction-vault.service';

describe('Fanfiction profile encryption', () => {
  let directory: string;
  let vault: FanfictionVaultService;
  const profile = randomUUID();
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bookorbit-vault-'));
    const module = await Test.createTestingModule({
      providers: [FanfictionVaultService, { provide: storageConfig.KEY, useValue: { appDataPath: directory } }],
    }).compile();
    vault = module.get(FanfictionVaultService);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const keyPath = () => join(directory, 'fanfiction/keys/profile-key-v1.json');
  it('atomically provisions one private key for concurrent profiles', async () => {
    const values = await Promise.all(Array.from({ length: 8 }, () => vault.encrypt(1, profile, 'secret', true)));
    expect(new Set(values.map((value) => value.keyId)).size).toBe(1);
    expect((await stat(keyPath())).mode & 0o777).toBe(0o600);
    for (const value of values) expect(await vault.decrypt(1, profile, value)).toBe('secret');
  });
  it('authenticates library, profile, ciphertext and key version', async () => {
    const value = await vault.encrypt(1, profile, 'secret', true);
    await expect(vault.decrypt(2, profile, value)).rejects.toThrow('authenticate');
    await expect(vault.decrypt(1, randomUUID(), value)).rejects.toThrow('authenticate');
    await expect(vault.decrypt(1, profile, { ...value, ciphertext: 'AAAA' })).rejects.toThrow('authenticate');
    await expect(vault.decrypt(1, profile, { ...value, keyId: randomUUID() })).rejects.toThrow('authenticate');
  });
  it('never replaces a lost or corrupt referenced key', async () => {
    const value = await vault.encrypt(1, profile, 'secret', true);
    await unlink(keyPath());
    await expect(vault.decrypt(1, profile, value)).rejects.toThrow('restore');
    await expect(vault.encrypt(1, profile, 'new', false)).rejects.toThrow('restore');
    await expect(stat(keyPath())).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(keyPath(), 'corrupt', { mode: 0o600 });
    await expect(vault.encrypt(1, profile, 'new', true)).rejects.toThrow('restore');
    expect(await readFile(keyPath(), 'utf8')).toBe('corrupt');
  });
});

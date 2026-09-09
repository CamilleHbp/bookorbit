import { BadRequestException, Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { constants } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fanficfareConfig, storageConfig } from '../../config/config';
import type { EncryptedFanfictionDocument } from '@bookorbit/types';

type ProfileKey = { version: 1; id: string; key: string };

@Injectable()
export class FanfictionVaultService {
  constructor(
    @Inject(storageConfig.KEY) private readonly storage: ConfigType<typeof storageConfig>,
    @Optional() @Inject(fanficfareConfig.KEY) private readonly config?: ConfigType<typeof fanficfareConfig>,
  ) {}

  async encrypt(libraryId: number, profileId: string, value: string, allowProvision: boolean): Promise<EncryptedFanfictionDocument> {
    if (Buffer.byteLength(value) > 128 * 1024) throw new BadRequestException('Fanfiction profile storage limit exceeded');
    const key = await this.key(allowProvision);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key.key, 'base64'), iv);
    cipher.setAAD(this.context(libraryId, profileId, key.id));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      version: 1,
      keyId: key.id,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  async decrypt(libraryId: number, profileId: string, value: EncryptedFanfictionDocument): Promise<string> {
    const key = await this.key(false);
    try {
      if (value.version !== 1 || value.keyId !== key.id) throw new ServiceUnavailableException();
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key.key, 'base64'), Buffer.from(value.iv, 'base64'));
      decipher.setAAD(this.context(libraryId, profileId, key.id));
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException({
        message: 'Fanfiction profile key is missing, mismatched, or unable to authenticate this profile',
        errorCode: 'configuration_blocked',
      });
    }
  }

  private context(libraryId: number, profileId: string, keyId: string): Buffer {
    return Buffer.from(JSON.stringify(['bookorbit-fanfiction-profile', 1, keyId, libraryId, profileId]));
  }

  private async key(allowProvision: boolean): Promise<ProfileKey> {
    if (this.config?.encryptionKey) {
      const key = Buffer.from(this.config.encryptionKey, 'base64');
      if (key.length !== 32 || key.toString('base64') !== this.config.encryptionKey)
        throw new ServiceUnavailableException({ message: 'Invalid operator profile key', errorCode: 'configuration_blocked' });
      return { version: 1, id: `operator-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`, key: key.toString('base64') };
    }
    const directory = join(this.storage.appDataPath, 'fanfiction', 'keys');
    const path = join(directory, 'profile-key-v1.json');
    try {
      return await this.readKey(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowProvision) {
        throw new ServiceUnavailableException({
          message: 'Fanfiction profile key is unavailable; restore the existing key',
          errorCode: 'configuration_blocked',
        });
      }
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.key-${randomUUID()}`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 1, id: randomUUID(), key: randomBytes(32).toString('base64') }));
      await handle.sync();
      await handle.close();
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const folder = await open(directory, 'r');
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
      return await this.readKey(path);
    } finally {
      await handle.close();
      await unlink(temporary).catch(() => {});
    }
  }

  private async readKey(path: string): Promise<ProfileKey> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) throw new ServiceUnavailableException('Invalid profile key file');
      const key = JSON.parse(await handle.readFile('utf8')) as ProfileKey;
      if (key.version !== 1 || !/^[a-f0-9-]{36}$/.test(key.id) || typeof key.key !== 'string' || Buffer.from(key.key, 'base64').length !== 32) {
        throw new ServiceUnavailableException('Invalid profile key');
      }
      return key;
    } finally {
      await handle.close();
    }
  }
}

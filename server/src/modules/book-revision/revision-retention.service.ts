import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { lstat, mkdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { storageConfig } from '../../config/config';
import { copyBoundedFile, requireInspectedFile, syncPath } from './revision-publication.files';

@Injectable()
export class RevisionRetentionService {
  constructor(@Inject(storageConfig.KEY) private readonly storage: ConfigType<typeof storageConfig>) {}

  path(bookFileId: number, revisionId: string): string {
    return join(this.storage.appDataPath, 'retained-revisions', String(bookFileId), `${revisionId}.epub`);
  }

  async retain(bookFileId: number, revisionId: string, backupPath: string, sha256: string): Promise<string> {
    const destination = this.path(bookFileId, revisionId);
    const directory = dirname(destination);
    await this.directory(dirname(directory));
    await this.directory(directory);
    if (await this.exists(destination)) {
      await requireInspectedFile(destination, sha256);
      return destination;
    }
    await requireInspectedFile(backupPath, sha256);
    const pending = join(directory, `.${revisionId}.pending`);
    await rm(pending, { force: true });
    await copyBoundedFile(backupPath, pending);
    await requireInspectedFile(pending, sha256);
    await rename(pending, destination);
    await syncPath(directory);
    return destination;
  }

  async remove(bookFileId: number, revisionId: string, storagePath: string, legacyPath: string): Promise<void> {
    if (storagePath !== this.path(bookFileId, revisionId) && storagePath !== legacyPath)
      throw new ConflictException('Invalid retained revision storage path');
    await rm(storagePath, { force: true });
    const directory = dirname(storagePath);
    try {
      await rmdir(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY') await syncPath(directory);
      else if (code !== 'ENOENT') throw error;
    }
    try {
      await syncPath(dirname(directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async directory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ConflictException('Retained revision directory is unsafe');
    await syncPath(dirname(path));
  }

  private async exists(path: string): Promise<boolean> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new ConflictException('Retained revision file is unsafe');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}

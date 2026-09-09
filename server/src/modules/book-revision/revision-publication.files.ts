import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { chmod, mkdir, open, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inspectStableFile, sameFileSignature, type InspectedFile } from './file-inspection';

export function publicationPaths(target: string, id: string) {
  const directory = join(dirname(target), `.bookorbit-revision-${id}`);
  return { directory, stagedPath: join(directory, 'next.epub'), backupPath: join(directory, 'previous.epub') };
}

export async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function removeCancelledPublication(targetPath: string, id: string): Promise<void> {
  const paths = publicationPaths(targetPath, id);
  await rm(paths.stagedPath, { force: true });
  await rm(paths.backupPath, { force: true });
  try {
    await rmdir(paths.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await syncPath(dirname(paths.directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function requireInspectedFile(path: string, sha256?: string): Promise<InspectedFile> {
  const result = await inspectStableFile(path);
  if (result.status !== 'stable') throw new ServiceUnavailableException('Revision file is unavailable or changing');
  if (sha256 && result.file.sha256 !== sha256) throw new ConflictException('Revision file content no longer matches the expected revision');
  return result.file;
}

export async function stagePublication(input: string, target: string, id: string, previousSha256: string) {
  const paths = publicationPaths(target, id);
  await mkdir(paths.directory, { mode: 0o700 });
  try {
    await copyBoundedFile(input, paths.stagedPath);
    await chmod(paths.stagedPath, 0o600);
    await copyBoundedFile(target, paths.backupPath);
    await chmod(paths.backupPath, 0o600);
    const fresh = await requireInspectedFile(paths.stagedPath);
    await requireInspectedFile(paths.backupPath, previousSha256);
    await syncPath(paths.stagedPath);
    await syncPath(paths.backupPath);
    await syncPath(paths.directory);
    await syncPath(dirname(target));
    return { ...paths, fresh };
  } catch (error) {
    await rm(paths.directory, { recursive: true, force: true });
    throw error;
  }
}

export async function publishStagedFile(stagedPath: string, targetPath: string): Promise<void> {
  const previous = await stat(targetPath);
  await chmod(stagedPath, previous.mode & 0o777);
  await syncPath(stagedPath);
  await rename(stagedPath, targetPath);
  await syncPath(dirname(targetPath));
}

export async function copyBoundedFile(source: string, destination: string): Promise<void> {
  const input = await open(source, 'r');
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.size > 512n * 1024n * 1024n) throw new ConflictException('Revision file exceeds the publication size limit');
    const output = await open(destination, 'wx', 0o600);
    try {
      const buffer = Buffer.allocUnsafe(128 * 1024);
      let position = 0;
      while (position < Number(before.size)) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position);
        if (!bytesRead) throw new ConflictException('Revision source changed while staging');
        let written = 0;
        while (written < bytesRead) {
          const { bytesWritten } = await output.write(buffer, written, bytesRead - written, position + written);
          if (!bytesWritten) throw new ServiceUnavailableException('Revision staging could not be written');
          written += bytesWritten;
        }
        position += bytesRead;
      }
      if (!sameFileSignature(before, await input.stat({ bigint: true })) || !sameFileSignature(before, await stat(source, { bigint: true }))) {
        throw new ConflictException('Revision source changed while staging');
      }
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

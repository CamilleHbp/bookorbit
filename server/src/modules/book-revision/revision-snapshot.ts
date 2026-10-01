import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, stat, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { sameFileSignature } from './file-inspection';

const MAX_BYTES = 512 * 1024 * 1024;
const BUFFER_BYTES = 128 * 1024;

export async function snapshotRevisionFile(
  source: string,
  directory: string,
  sha256: string,
  sizeBytes: number,
  checkAccess: () => Promise<void>,
): Promise<FileHandle> {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_BYTES)
    throw new ConflictException('Revision exceeds the download size limit');
  await checkAccess();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const snapshotPath = join(directory, `${randomUUID()}.epub`);
  const snapshot = await open(snapshotPath, 'wx+', 0o600);
  try {
    // An anonymous descriptor survives replacement but leaves no temporary file after a crash.
    await unlink(snapshotPath);
    const input = await open(source, 'r');
    try {
      const before = await input.stat({ bigint: true });
      if (!before.isFile() || before.size !== BigInt(sizeBytes)) throw new ConflictException('Revision file size changed');
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
      const deadline = performance.now() + 120_000;
      let checkedAt = performance.now();
      let position = 0;
      while (position < sizeBytes) {
        if (performance.now() > deadline) throw new ServiceUnavailableException('Revision snapshot exceeded its time limit');
        if (performance.now() - checkedAt >= 1000) {
          await checkAccess();
          checkedAt = performance.now();
        }
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, sizeBytes - position), position);
        if (!bytesRead) throw new ConflictException('Revision file changed during download preparation');
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const { bytesWritten } = await snapshot.write(buffer, written, bytesRead - written, position + written);
          if (!bytesWritten) throw new ServiceUnavailableException('Revision snapshot could not be written');
          written += bytesWritten;
        }
        position += bytesRead;
      }
      if (
        hash.digest('hex') !== sha256 ||
        !sameFileSignature(before, await input.stat({ bigint: true })) ||
        !sameFileSignature(before, await stat(source, { bigint: true }))
      ) {
        throw new ConflictException('Revision file no longer matches the expected revision');
      }
      await checkAccess();
      return snapshot;
    } finally {
      await input.close();
    }
  } catch (error) {
    await snapshot.close();
    await unlink(snapshotPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ConflictException('Revision file is no longer available');
    throw error;
  }
}

export function streamRevisionSnapshot(snapshot: FileHandle, sizeBytes: number, checkAccess: () => Promise<void>, release: () => void): Readable {
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await snapshot.close();
    } finally {
      release();
    }
  };
  async function* chunks() {
    try {
      await checkAccess();
      let checkedAt = performance.now();
      let position = 0;
      while (position < sizeBytes) {
        if (performance.now() - checkedAt >= 1000) {
          await checkAccess();
          checkedAt = performance.now();
        }
        const buffer = Buffer.allocUnsafe(Math.min(BUFFER_BYTES, sizeBytes - position));
        const { bytesRead } = await snapshot.read(buffer, 0, buffer.length, position);
        if (!bytesRead) throw new ConflictException('Revision snapshot ended unexpectedly');
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    } finally {
      await close();
    }
  }
  const stream = Readable.from(chunks(), { objectMode: false, highWaterMark: BUFFER_BYTES });
  const timeout = setTimeout(() => stream.destroy(new ServiceUnavailableException('Revision download exceeded its time limit')), 10 * 60_000);
  timeout.unref();
  stream.once('close', () => {
    clearTimeout(timeout);
    void close().catch(() => undefined);
  });
  return stream;
}

import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export interface FileSignature {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface InspectedFile {
  signature: FileSignature;
  ino: bigint;
  sizeBytes: number;
  mtime: Date;
  sha256: string;
  fileHash: string;
}

export type FileInspectionResult =
  | { status: 'stable'; file: InspectedFile }
  | { status: 'missing' }
  | { status: 'retryable'; reason: 'unreadable' | 'changed' | 'not_regular' | 'too_large' };

export function sameFileSignature(a: FileSignature, b: FileSignature): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function signature(s: BigIntStats): FileSignature {
  return { dev: s.dev, ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs };
}

export async function waitForStableFile(path: string): Promise<'stable' | 'missing' | 'retryable'> {
  try {
    let previous = await stat(path, { bigint: true });
    if (!previous.isFile()) return 'retryable';
    if (Date.now() - Math.max(Number(previous.mtimeMs), Number(previous.ctimeMs)) > 60_000) return 'stable';
    const deadline = Date.now() + 60_000;
    let unchangedSince = Date.now();
    while (Date.now() < deadline) {
      await delay(1000);
      const current = await stat(path, { bigint: true });
      if (!current.isFile()) return 'retryable';
      if (!sameFileSignature(previous, current)) unchangedSince = Date.now();
      else if (Date.now() - unchangedSince >= 10_000) return 'stable';
      previous = current;
    }
    return 'retryable';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'retryable';
  }
}

export async function inspectStableFile(path: string): Promise<FileInspectionResult> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return { status: 'retryable', reason: 'not_regular' };
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) return { status: 'retryable', reason: 'too_large' };
    const sha256 = createHash('sha256');
    const buffer = Buffer.allocUnsafe(128 * 1024);
    const size = Number(before.size);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) return { status: 'retryable', reason: 'changed' };
      sha256.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const md5 = createHash('md5');
    for (let i = -1; i <= 10; i++) {
      const offset = 1024 << (2 * i);
      if (offset >= size) break;
      const expected = Math.min(1024, size - offset);
      let read = 0;
      while (read < expected) {
        const { bytesRead } = await handle.read(buffer, read, expected - read, offset + read);
        if (!bytesRead) return { status: 'retryable', reason: 'changed' };
        read += bytesRead;
      }
      md5.update(buffer.subarray(0, read));
    }
    const after = await handle.stat({ bigint: true });
    const atPath = await stat(path, { bigint: true });
    if (!sameFileSignature(before, after) || !sameFileSignature(after, atPath)) return { status: 'retryable', reason: 'changed' };
    return {
      status: 'stable',
      file: {
        signature: signature(after),
        ino: after.ino,
        sizeBytes: size,
        mtime: after.mtime,
        sha256: sha256.digest('hex'),
        fileHash: md5.digest('hex'),
      },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { status: 'missing' } : { status: 'retryable', reason: 'unreadable' };
  } finally {
    await handle?.close();
  }
}

import { createHash } from 'node:crypto';
import { mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeFileHash } from '../scanner/lib/hash';
import { inspectStableFile } from './file-inspection';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bookorbit-revision-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('stable file inspection', () => {
  it('streams exact identity while preserving KOReader partial MD5', async () => {
    const path = join(dir, 'book.epub');
    const bytes = Buffer.alloc(300_000, 'abc');
    await writeFile(path, bytes);
    const result = await inspectStableFile(path);
    expect(result).toMatchObject({
      status: 'stable',
      file: {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        fileHash: await computeFileHash(path),
        sizeBytes: bytes.length,
      },
    });
  });

  it('detects changed bytes outside the partial MD5 samples', async () => {
    const path = join(dir, 'book.epub');
    const bytes = Buffer.alloc(300_000, 0);
    await writeFile(path, bytes);
    const first = await inspectStableFile(path);
    bytes[120_000] = 1;
    await writeFile(path, bytes);
    const second = await inspectStableFile(path);
    expect(first.status).toBe('stable');
    expect(second.status).toBe('stable');
    if (first.status === 'stable' && second.status === 'stable') {
      expect(first.file.fileHash).toBe(second.file.fileHash);
      expect(first.file.sha256).not.toBe(second.file.sha256);
    }
  });

  it('rejects an atomic path replacement during inspection', async () => {
    const path = join(dir, 'book.epub');
    const replacement = join(dir, 'replacement.epub');
    await writeFile(path, Buffer.alloc(200_000, 1));
    await writeFile(replacement, Buffer.alloc(200_000, 2));
    const handle = await open(path, 'r');
    const originalRead = handle.read.bind(handle);
    vi.spyOn(handle, 'read').mockImplementationOnce(async (...args: Parameters<typeof handle.read>) => {
      await rename(replacement, path);
      return originalRead(...args);
    });
    vi.mocked(open).mockResolvedValueOnce(handle);
    expect(await inspectStableFile(path)).toEqual({ status: 'retryable', reason: 'changed' });
  });

  it('does not report a missing file or directory as a valid revision', async () => {
    expect(await inspectStableFile(join(dir, 'missing'))).toEqual({ status: 'missing' });
    expect(await inspectStableFile(dir)).toEqual({ status: 'retryable', reason: 'not_regular' });
  });

  it('supports an empty file without reading uninitialized bytes', async () => {
    const path = join(dir, 'empty');
    await writeFile(path, '');
    expect(await inspectStableFile(path)).toMatchObject({
      status: 'stable',
      file: {
        sizeBytes: 0,
        sha256: createHash('sha256').digest('hex'),
        fileHash: createHash('md5').digest('hex'),
      },
    });
  });
});

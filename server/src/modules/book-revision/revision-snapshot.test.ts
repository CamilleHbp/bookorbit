import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForbiddenException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotRevisionFile, streamRevisionSnapshot } from './revision-snapshot';

let directory: string;
let source: string;
let snapshots: string;
const original = Buffer.from('The original text. '.repeat(30_000));
const digest = createHash('sha256').update(original).digest('hex');
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bookorbit-snapshot-test-'));
  source = join(directory, 'source.epub');
  snapshots = join(directory, 'snapshots');
  await writeFile(source, original);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function consume(stream: ReturnType<typeof streamRevisionSnapshot>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('verified revision snapshots', () => {
  it.each(['in-place', 'atomic'])('streams verified original bytes after an %s replacement', async (replacement) => {
    const access = vi.fn().mockResolvedValue(undefined);
    const handle = await snapshotRevisionFile(source, snapshots, digest, original.length, access);
    expect(await readdir(snapshots)).toEqual([]);
    if (replacement === 'atomic') {
      const next = join(directory, 'next.epub');
      await writeFile(next, 'Replacement');
      await rename(next, source);
    } else await writeFile(source, 'Replacement');
    const release = vi.fn();
    expect(await consume(streamRevisionSnapshot(handle, original.length, access, release))).toEqual(original);
    expect(release).toHaveBeenCalledOnce();
    await expect(handle.stat()).rejects.toThrow();
  });

  it('rejects changed size and mismatched hashes without leaving staged files', async () => {
    await expect(snapshotRevisionFile(source, snapshots, digest, original.length + 1, async () => {})).rejects.toThrow('size changed');
    await expect(snapshotRevisionFile(source, snapshots, '0'.repeat(64), original.length, async () => {})).rejects.toThrow('no longer matches');
    expect(await readdir(snapshots)).toEqual([]);
  });

  it('bounds archive size before allocating temporary storage', async () => {
    await expect(snapshotRevisionFile(source, snapshots, digest, 512 * 1024 * 1024 + 1, async () => {})).rejects.toThrow('size limit');
    expect(await readdir(directory)).toEqual(['source.epub']);
  });

  it('closes the snapshot when access is revoked after preparation', async () => {
    const access = vi.fn().mockResolvedValue(undefined);
    const handle = await snapshotRevisionFile(source, snapshots, digest, original.length, access);
    access.mockRejectedValue(new ForbiddenException());
    const release = vi.fn();
    await expect(consume(streamRevisionSnapshot(handle, original.length, access, release))).rejects.toBeInstanceOf(ForbiddenException);
    expect(release).toHaveBeenCalledOnce();
    await expect(handle.stat()).rejects.toThrow();
  });

  it('releases an unconsumed snapshot when the client disconnects', async () => {
    const handle = await snapshotRevisionFile(source, snapshots, digest, original.length, async () => {});
    const release = vi.fn();
    const stream = streamRevisionSnapshot(handle, original.length, async () => {}, release);
    stream.destroy();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    await expect(handle.stat()).rejects.toThrow();
  });
});

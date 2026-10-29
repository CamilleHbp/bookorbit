import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicationPaths, publishStagedFile, requireInspectedFile, stagePublication } from './revision-publication.files';

let dir: string;
let target: string;
let input: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bookorbit-stage-'));
  target = join(dir, 'story.epub');
  input = join(dir, 'incoming.epub');
  await writeFile(target, 'previous');
  await writeFile(input, 'next');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('durable revision files', () => {
  it('stages privately on the destination filesystem and preserves published permissions', async () => {
    await chmod(target, 0o640);
    const old = await requireInspectedFile(target);
    const staged = await stagePublication(input, target, 'test', old.sha256);
    expect((await stat(staged.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(staged.stagedPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(target, 'utf8')).toBe('previous');
    await publishStagedFile(staged.stagedPath, target);
    expect(await readFile(target, 'utf8')).toBe('next');
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect(await readFile(staged.backupPath, 'utf8')).toBe('previous');
  });

  it('rejects oversized sources before allocating their output', async () => {
    const handle = await open(input, 'w');
    await handle.truncate(513 * 1024 * 1024);
    await handle.close();
    const old = await requireInspectedFile(target);
    await expect(stagePublication(input, target, 'oversized', old.sha256)).rejects.toThrow('size limit');
    expect(await readdir(dir)).toEqual(expect.arrayContaining(['story.epub', 'incoming.epub']));
    await expect(stat(publicationPaths(target, 'oversized').directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(target, 'utf8')).toBe('previous');
  });

  it('discards staging if the original no longer matches its revision', async () => {
    await expect(stagePublication(input, target, 'stale', '0'.repeat(64))).rejects.toThrow('no longer matches');
    await expect(stat(publicationPaths(target, 'stale').directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(target, 'utf8')).toBe('previous');
  });
});

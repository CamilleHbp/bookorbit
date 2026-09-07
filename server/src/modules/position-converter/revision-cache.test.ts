import { Test } from '@nestjs/testing';
import { ZipArchive } from 'archiver';
import { mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as unzipper from 'unzipper';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from '../../db';
import { EpubDomService } from './epub-dom.service';
import { KepubDomService } from './kepub-dom.service';

const stamp = new Date('2026-01-01T00:00:00Z');
async function epub(path: string, text: string) {
  const archive = new ZipArchive({ store: true });
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  for (const [name, content] of Object.entries({
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
    'content.opf': '<package><manifest><item id="chapter" href="chapter.xhtml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    'chapter.xhtml': `<html><body><p>${text}</p></body></html>`,
  }))
    archive.append(content, { name, date: stamp });
  await archive.finalize();
  await done;
  await writeFile(path, Buffer.concat(chunks));
  await utimes(path, stamp, stamp);
}

describe.each(['epub', 'kepub'] as const)('%s conversion cache identity', (format) => {
  let directory: string;
  let path: string;
  let replacement: string;
  let row: { absolutePath: string; format: string; revisionId: string; sha256: string };
  let load: () => ReturnType<EpubDomService['getChapter']>;
  let primeSpine: () => Promise<unknown>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bookorbit-revision-cache-'));
    path = join(directory, 'story.epub');
    replacement = join(directory, 'replacement.epub');
    await epub(path, 'original passage');
    await epub(replacement, 'replaced passage');
    row = { absolutePath: path, format: 'epub', revisionId: 'original', sha256: 'a'.repeat(64) };
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ ...row }]) }) }) }) };
    const module = await Test.createTestingModule({
      providers: [EpubDomService, KepubDomService, { provide: DB, useValue: db }],
    }).compile();
    const service = module.get(EpubDomService);
    const kepub = module.get(KepubDomService);
    load = format === 'epub' ? () => service.getChapter(1, 0) : () => kepub.getChapterByIndex(path, 0);
    primeSpine = format === 'epub' ? () => service.getChapterCount(1) : () => kepub.getSpine(path);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('invalidates an atomic replacement with the same pathname, timestamp and size', async () => {
    const original = await load();
    expect(original?.index.collapsed).toBe('original passage');
    const oldStat = await stat(path);
    await rename(replacement, path);
    const nextStat = await stat(path);
    expect(nextStat.mtimeMs).toBe(oldStat.mtimeMs);
    expect(nextStat.size).toBe(oldStat.size);
    const next = await load();
    expect(next?.index.collapsed).toBe('replaced passage');
    expect(next).not.toBe(original);
    expect(await load()).toBe(next);
  });

  it('invalidates an in-place overwrite even when modification time is restored', async () => {
    const original = await load();
    const before = await stat(path);
    await writeFile(path, await readFile(replacement));
    await utimes(path, stamp, stamp);
    expect((await stat(path)).ino).toBe(before.ino);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect((await load())?.index.collapsed).toBe('replaced passage');
    expect(await load()).not.toBe(original);
  });

  it('rejects a chapter replaced while being read and recovers on the next inspection', async () => {
    await primeSpine();
    const open = unzipper.Open.file;
    vi.spyOn(unzipper.Open, 'file').mockImplementationOnce(async (...args) => {
      const archive = await open(...args);
      const chapter = archive.files.find((entry) => entry.path === 'chapter.xhtml')!;
      const buffer = chapter.buffer.bind(chapter);
      chapter.buffer = async (...options) => {
        const bytes = await buffer(...options);
        await rename(replacement, path);
        return bytes;
      };
      return archive;
    });
    expect(await load()).toBeNull();
    expect((await load())?.index.collapsed).toBe('replaced passage');
  });

  it('does not return a cached chapter after the file disappears', async () => {
    expect(await load()).not.toBeNull();
    await rm(path);
    expect(await load()).toBeNull();
  });

  if (format === 'epub') {
    it('invalidates a changed database revision even when the bytes are unchanged', async () => {
      const original = await load();
      row.revisionId = 'next';
      expect(await load()).not.toBe(original);
    });

    it('rejects a revision reassigned during chapter conversion', async () => {
      await primeSpine();
      const open = unzipper.Open.file;
      vi.spyOn(unzipper.Open, 'file').mockImplementationOnce(async (...args) => {
        const archive = await open(...args);
        row.revisionId = 'next';
        return archive;
      });
      expect(await load()).toBeNull();
      expect((await load())?.index.collapsed).toBe('original passage');
    });
  }
});

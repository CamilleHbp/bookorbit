import { Test } from '@nestjs/testing';
import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { EpubManifestService } from './epub-manifest.service';

let dir: string;
let service: EpubManifestService;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bookorbit-manifest-'));
  const module = await Test.createTestingModule({ providers: [EpubManifestService] }).compile();
  service = module.get(EpubManifestService);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function epub(
  name: string,
  chapters = ['<h1>One</h1><p>Hello 😀 world</p>'],
  options: { cover?: string; title?: string; href?: string; pretty?: boolean; duplicate?: boolean } = {},
) {
  const path = join(dir, name);
  const output = createWriteStream(path);
  const archive = new ZipArchive({ zlib: { level: options.pretty ? 0 : 6 } });
  const items = chapters.map((_, i) => `<item id="c${i}" href="${options.href ?? `c${i}.xhtml`}" media-type="application/xhtml+xml"/>`).join('');
  const refs = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('');
  const opf = `<package><metadata><title>${options.title ?? 'Story'}</title></metadata><manifest>${items}<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/></manifest><spine>${refs}</spine></package>`;
  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append('application/epub+zip', { name: 'mimetype', store: true });
    archive.append('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>', { name: 'META-INF/container.xml' });
    archive.append(options.pretty ? opf.replaceAll('><', '>\n  <') : opf, { name: 'OPS/book.opf' });
    chapters.forEach((content, i) => archive.append(`<html><body>${content}</body></html>`, { name: `OPS/c${i}.xhtml` }));
    archive.append(options.cover ?? 'cover', { name: 'OPS/cover.png' });
    if (options.duplicate) archive.append('duplicate', { name: 'OPS/c0.xhtml' });
    void archive.finalize();
  });
  return path;
}

describe('EPUB revision manifests', () => {
  it('ignores compression and package indentation while retaining chapter identity', async () => {
    const first = await service.inspect(await epub('first.epub'));
    const second = await service.inspect(await epub('second.epub', undefined, { pretty: true }));
    expect(first).toEqual(second);
    expect(first.chapters[0]).toMatchObject({ href: 'OPS/c0.xhtml', title: 'One', length: 17 });
  });
  it('distinguishes appended chapters from metadata and cover updates', async () => {
    const original = await service.inspect(await epub('original.epub'));
    const appended = await service.inspect(await epub('append.epub', ['<h1>One</h1><p>Hello 😀 world</p>', '<p>Next chapter</p>']));
    expect(appended.chapters[0]).toEqual(original.chapters[0]);
    expect(appended.contentHash).not.toBe(original.contentHash);
    const metadata = await service.inspect(await epub('metadata.epub', undefined, { title: 'Renamed' }));
    expect(metadata.contentHash).toBe(original.contentHash);
    expect(metadata.metadataHash).not.toBe(original.metadataHash);
    const cover = await service.inspect(await epub('cover.epub', undefined, { cover: 'new cover' }));
    expect(cover.contentHash).toBe(original.contentHash);
    expect(cover.coverHash).not.toBe(original.coverHash);
  });
  it('excludes scripts and hidden content from visible-text anchors', async () => {
    const manifest = await service.inspect(await epub('hidden.epub', ['<p>Hello</p><script>secret</script><span hidden>hidden</span>']));
    expect(manifest.chapters[0].length).toBe(5);
  });
  it('rejects escaping resource references and duplicate entries', async () => {
    await expect(service.inspect(await epub('escape.epub', undefined, { href: '../../outside.xhtml' }))).rejects.toThrow('unsafe archive path');
    await expect(service.inspect(await epub('duplicate.epub', undefined, { duplicate: true }))).rejects.toThrow('duplicate archive entries');
  });
  it('rejects an empty reading spine', async () => {
    await expect(service.inspect(await epub('empty.epub', []))).rejects.toThrow('no readable chapters');
  });
});

import { Test } from '@nestjs/testing';
import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { EpubManifestService } from './epub-manifest.service';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  options: {
    cover?: string;
    title?: string;
    href?: string;
    pretty?: boolean;
    duplicate?: boolean;
    metadata?: string;
    titlepage?: string;
    chapterHead?: string;
  } = {},
) {
  const path = join(dir, name);
  const output = createWriteStream(path);
  const archive = new ZipArchive({ zlib: { level: options.pretty ? 0 : 6 } });
  const items =
    (options.titlepage ? '<item id="title_page" href="title_page.xhtml" media-type="application/xhtml+xml"/>' : '') +
    chapters.map((_, i) => `<item id="c${i}" href="${options.href ?? `c${i}.xhtml`}" media-type="application/xhtml+xml"/>`).join('');
  const refs = (options.titlepage ? '<itemref idref="title_page"/>' : '') + chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('');
  const opf = `<package><metadata><title>${options.title ?? 'Story'}</title>${options.metadata ?? ''}</metadata><manifest>${items}<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/></manifest><spine>${refs}</spine></package>`;
  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append('application/epub+zip', { name: 'mimetype', store: true });
    archive.append('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>', { name: 'META-INF/container.xml' });
    archive.append(options.pretty ? opf.replaceAll('><', '>\n  <') : opf, { name: 'OPS/book.opf' });
    chapters.forEach((content, i) =>
      archive.append(`<html><head>${options.chapterHead ?? ''}</head><body>${content}</body></html>`, { name: `OPS/c${i}.xhtml` }),
    );
    if (options.titlepage) archive.append(`<html><body class="fff_titlepage">${options.titlepage}</body></html>`, { name: 'OPS/title_page.xhtml' });
    archive.append(options.cover ?? 'cover', { name: 'OPS/cover.png' });
    if (options.duplicate) archive.append('duplicate', { name: 'OPS/c0.xhtml' });
    void archive.finalize();
  });
  return path;
}

describe('EPUB revision manifests', () => {
  it.skipIf(!process.env.FANFICFARE_TEST_PYTHON)(
    'ignores packaging dates in actual pinned FanFicFare output',
    async () => {
      const runtime = join(import.meta.dirname, '../fanfiction/runtime');
      await promisify(execFile)(
        process.env.FANFICFARE_TEST_PYTHON!,
        ['-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); from semantic_fixture import generate; generate(sys.argv[2])', runtime, dir],
        { timeout: 30_000 },
      );
      const first = await service.inspect(join(dir, 'first.epub'));
      const second = await service.inspect(join(dir, 'second.epub'));
      expect(first.chapters[0]?.textHash).not.toBe(second.chapters[0]?.textHash);
      expect(first.contentHash).toBe(second.contentHash);
      expect(first.metadataHash).toBe(second.metadataHash);
    },
    40_000,
  );
  it('ignores FanFicFare packaging dates while retaining generated pages for reading anchors', async () => {
    const metadata = (date: string) =>
      `<contributor>FanFicFare [https://github.com/JimmXinu/FanFicFare]</contributor><date opf:event="creation">${date}</date><meta property="dcterms:modified">${date}T00:00:00Z</meta>`;
    const titlepage = (date: string, status = 'In-Progress') => `<div><b>Packaged:</b> ${date}<br/><b>Status:</b> ${status}<br/></div>`;
    const first = await service.inspect(
      await epub('packaged-first.epub', undefined, { metadata: metadata('2026-01-01'), titlepage: titlepage('2026-01-01') }),
    );
    const second = await service.inspect(
      await epub('packaged-second.epub', undefined, { metadata: metadata('2026-02-01'), titlepage: titlepage('2026-02-01') }),
    );
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.metadataHash).toBe(second.metadataHash);
    expect(first.chapters).toHaveLength(2);
    expect(first.chapters[0]?.textHash).not.toBe(second.chapters[0]?.textHash);
    const status = await service.inspect(
      await epub('status.epub', undefined, { metadata: metadata('2026-02-01'), titlepage: titlepage('2026-02-01', 'Completed') }),
    );
    expect(status.contentHash).toBe(first.contentHash);
    expect(status.metadataHash).not.toBe(first.metadataHash);
  });

  it('retains FanFicFare chapter URLs stored in the XHTML head', async () => {
    const manifest = await service.inspect(
      await epub('chapter-source.epub', undefined, { chapterHead: '<meta name="chapterurl" content="https://example.org/story/chapter/1"/>' }),
    );
    expect(manifest.chapters[0]?.sourceUrl).toBe('https://example.org/story/chapter/1');
  });
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
  it('bounds retained chapter evidence without truncating its content identity', async () => {
    const title = '😀'.repeat(1024);
    const manifest = await service.inspect(await epub('long-heading.epub', [`<h1>${title}</h1>`]));
    expect([...manifest.chapters[0].title]).toHaveLength(512);
    expect(manifest.chapters[0].length).toBe(1024);
    await expect(service.inspect(await epub('long-path.epub', undefined, { href: 'x'.repeat(4097) }))).rejects.toThrow('unsafe archive path');
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

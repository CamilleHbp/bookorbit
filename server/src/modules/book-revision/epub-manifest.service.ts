import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { stat } from 'node:fs/promises';
import * as unzipper from 'unzipper';
import { XMLParser } from 'fast-xml-parser';
import { load } from 'cheerio';
import type { RevisionChapter } from '@bookorbit/types';
import { normalizeAnchorText, scalarLength } from './anchor-text';

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, processEntities: false });

interface PackageDocument {
  metadata?: unknown;
  manifest?: { item?: ManifestItem | ManifestItem[] };
  spine?: { itemref?: { '@_idref'?: string; '@_linear'?: string } | { '@_idref'?: string; '@_linear'?: string }[] };
}
interface ManifestItem {
  '@_id'?: string;
  '@_href'?: string;
  '@_media-type'?: string;
  '@_properties'?: string;
}

export interface EpubRevisionManifest {
  version: 1;
  chapters: RevisionChapter[];
  contentHash: string;
  metadataHash: string;
  coverHash: string | null;
}

function list<T>(value: T | T[] | undefined): T[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}
function digest(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return typeof value === 'string' ? normalizeAnchorText(value) : value;
}

function archivePath(value: string): string {
  if (
    !value ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    value.split('/').includes('..') ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  ) {
    throw new BadRequestException('EPUB contains an unsafe archive path');
  }
  return posix.normalize(value);
}

function resolveHref(base: string, href: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split('#')[0].split('?')[0]);
  } catch {
    throw new BadRequestException('EPUB contains an invalid resource reference');
  }
  if (!decoded || decoded.startsWith('/') || decoded.includes('\\') || /^[a-z][a-z\d+.-]*:/i.test(decoded)) {
    throw new BadRequestException('EPUB references an unsafe resource');
  }
  return archivePath(posix.join(base, decoded));
}

@Injectable()
export class EpubManifestService {
  async inspect(path: string): Promise<EpubRevisionManifest> {
    if ((await stat(path)).size > MAX_ARCHIVE_BYTES) throw new BadRequestException('EPUB exceeds the archive size limit');
    let zip: unzipper.CentralDirectory;
    try {
      zip = await unzipper.Open.file(path);
    } catch {
      throw new BadRequestException('Invalid EPUB archive');
    }
    if (zip.files.length > MAX_ENTRIES) throw new BadRequestException('EPUB contains too many archive entries');
    const files = new Map<string, unzipper.File>();
    let expanded = 0;
    for (const entry of zip.files) {
      const name = archivePath(entry.path);
      if (files.has(name)) throw new BadRequestException('EPUB contains duplicate archive entries');
      if (entry.uncompressedSize > MAX_ENTRY_BYTES || (expanded += entry.uncompressedSize) > MAX_EXPANDED_BYTES) {
        throw new BadRequestException('EPUB exceeds the expanded size limit');
      }
      files.set(name, entry);
    }
    const read = async (name: string): Promise<Buffer> => {
      const entry = files.get(name);
      if (!entry || entry.type !== 'File') throw new BadRequestException('EPUB is missing a required resource');
      const chunks: Buffer[] = [];
      let bytes = 0;
      const stream = entry.stream();
      try {
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_ENTRY_BYTES || bytes > entry.uncompressedSize) throw new BadRequestException('EPUB resource exceeds its declared size');
          chunks.push(buffer);
        }
      } catch {
        throw new BadRequestException('EPUB resource is invalid or exceeds its size limit');
      } finally {
        stream.destroy();
      }
      if (bytes !== entry.uncompressedSize) throw new BadRequestException('EPUB resource is truncated');
      return Buffer.concat(chunks, bytes);
    };
    if ((await read('mimetype')).toString().trim() !== 'application/epub+zip') throw new BadRequestException('File is not an EPUB');
    const container = this.parseXml((await read('META-INF/container.xml')).toString()) as {
      container?: { rootfiles?: { rootfile?: { '@_full-path'?: string } | { '@_full-path'?: string }[] } };
    };
    const rootPath = list(container.container?.rootfiles?.rootfile)[0]?.['@_full-path'];
    if (!rootPath) throw new BadRequestException('EPUB has no package document');
    const packagePath = archivePath(rootPath);
    const document = this.parseXml((await read(packagePath)).toString()) as { package?: PackageDocument };
    const pkg = document.package;
    if (!pkg) throw new BadRequestException('Invalid EPUB package document');
    const base = posix.dirname(packagePath);
    const items = new Map<string, ManifestItem>();
    for (const item of list(pkg.manifest?.item)) {
      if (!item['@_id'] || !item['@_href'] || items.has(item['@_id'])) throw new BadRequestException('Invalid EPUB manifest identity');
      items.set(item['@_id'], item);
    }
    const chapters: RevisionChapter[] = [];
    const spine = list(pkg.spine?.itemref);
    if (spine.length > MAX_ENTRIES || items.size > MAX_ENTRIES) throw new BadRequestException('EPUB manifest exceeds the item limit');
    for (const ref of spine) {
      const item = items.get(ref['@_idref'] ?? '');
      if (!item) throw new BadRequestException('EPUB spine references a missing chapter');
      if (ref['@_linear'] === 'no') continue;
      const href = resolveHref(base, item['@_href']!);
      const $ = load((await read(href)).toString());
      $('script, style, head, [hidden]').remove();
      const title = normalizeAnchorText($('h1,h2,h3').first().text());
      const sourceUrl = $('a.chapterurl').first().attr('href');
      $('br').replaceWith(' ');
      $('p,div,section,li,h1,h2,h3,h4,h5,h6').append(' ');
      const text = normalizeAnchorText($('body').text());
      chapters.push({
        href,
        title,
        ...(sourceUrl && /^https?:\/\//i.test(sourceUrl) ? { sourceUrl } : {}),
        textHash: digest(text),
        length: scalarLength(text),
      });
    }
    if (!chapters.length) throw new BadRequestException('EPUB has no readable chapters');
    let coverHash: string | null = null;
    const metadata = pkg.metadata as
      { meta?: { '@_name'?: string; '@_content'?: string } | { '@_name'?: string; '@_content'?: string }[] } | undefined;
    const coverId = list(metadata?.meta).find((meta) => meta['@_name'] === 'cover')?.['@_content'];
    const resources: string[] = [];
    for (const item of items.values()) {
      const media = item['@_media-type'] ?? '';
      if (media === 'application/xhtml+xml' || media === 'text/html' || media === 'application/x-dtbncx+xml') continue;
      const bytes = await read(resolveHref(base, item['@_href']!));
      const hash = digest(bytes);
      if (item['@_id'] === coverId || (item['@_properties'] ?? '').split(/\s+/).includes('cover-image')) coverHash = hash;
      else resources.push(hash);
    }
    return {
      version: 1,
      chapters,
      contentHash: digest(JSON.stringify({ chapters: chapters.map((chapter) => chapter.textHash), resources: resources.sort() })),
      metadataHash: digest(JSON.stringify(canonical(pkg.metadata ?? {}))),
      coverHash,
    };
  }

  private parseXml(text: string): unknown {
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new BadRequestException('EPUB package declarations are not supported');
    try {
      return parser.parse(text);
    } catch {
      throw new BadRequestException('Invalid EPUB XML');
    }
  }
}

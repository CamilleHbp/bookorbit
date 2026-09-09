import { load, type CheerioAPI } from 'cheerio';
import { normalizeAnchorText } from './anchor-text';

function list(value: unknown): unknown[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function isFanficfarePackage(metadata: unknown): boolean {
  return list(record(metadata).contributor).some((value) => {
    const text = typeof value === 'string' ? value : record(value)['#text'];
    return typeof text === 'string' && /^FanFicFare \[https:\/\/github\.com\/JimmXinu\/FanFicFare\]/.test(text);
  });
}

export function semanticPackageMetadata(metadata: unknown) {
  const result = { ...record(metadata) };
  if (result.meta !== undefined) {
    result.meta = list(result.meta).filter((value) => {
      const item = record(value);
      return item['@_property'] !== 'dcterms:modified' && item['@_name'] !== 'calibre:timestamp';
    });
    if (!(result.meta as unknown[]).length) delete result.meta;
  }
  if (result.date !== undefined) {
    result.date = list(result.date).filter((value) => record(value)['@_event'] !== 'creation');
    if (!(result.date as unknown[]).length) delete result.date;
  }
  return result;
}

export function visibleChapterText($: CheerioAPI): string {
  $('script, style, head, [hidden]').remove();
  $('br').replaceWith(' ');
  $('p,div,section,li,h1,h2,h3,h4,h5,h6').append(' ');
  return normalizeAnchorText($('body').text());
}

export function generatedPageText(html: string, titlePage: boolean): string {
  const $ = load(html);
  if (titlePage && $('body.fff_titlepage').length) {
    $('[data-bookorbit-metadata="dateCreated"]').remove();
    $('body.fff_titlepage b').each((_, label) => {
      if (normalizeAnchorText($(label).text()) !== 'Packaged:') return;
      const row = $(label).closest('tr');
      if (row.length) {
        row.remove();
        return;
      }
      const nodes: NonNullable<typeof label.next>[] = [];
      let next = label.next;
      while (next && nodes.length < 32 && !$(next).is('br')) {
        nodes.push(next);
        next = next.next;
      }
      if (next && $(next).is('br')) {
        $(nodes).remove();
        $(label).remove();
      }
    });
  }
  return visibleChapterText($);
}

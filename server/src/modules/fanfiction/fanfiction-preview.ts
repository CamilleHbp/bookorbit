import { ServiceUnavailableException } from '@nestjs/common';
import type { FanfictionPreview } from '@bookorbit/types';

export function validateFanfictionPreview(value: unknown): FanfictionPreview {
  const invalid = () => new ServiceUnavailableException('Invalid FanFicFare story metadata');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  const string = (key: string, maximum: number, empty = true): string => {
    const text = row[key];
    if (typeof text !== 'string' || text.length > maximum || (!empty && !text.trim())) throw invalid();
    return text;
  };
  const strings = (key: string, maximum: number, length: number): string[] => {
    const items = row[key];
    if (!Array.isArray(items) || items.length > maximum || items.some((item) => typeof item !== 'string' || item.length > length)) throw invalid();
    return items as string[];
  };
  const canonicalUrl = string('canonicalUrl', 4096, false);
  let url: URL;
  try {
    url = new URL(canonicalUrl);
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw invalid();
  if (!Number.isInteger(row.chapterCount) || Number(row.chapterCount) < 1 || Number(row.chapterCount) > 10_000) throw invalid();
  return {
    canonicalUrl,
    site: string('site', 255, false),
    title: string('title', 500, false),
    authors: strings('authors', 100, 500),
    description: string('description', 256 * 1024),
    chapterCount: Number(row.chapterCount),
    status: string('status', 100),
    tags: strings('tags', 1000, 500),
  };
}

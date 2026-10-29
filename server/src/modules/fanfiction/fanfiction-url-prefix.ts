import { BadRequestException } from '@nestjs/common';
import { or, sql, type SQL } from 'drizzle-orm';

export function normalizeUrlPrefixes(values: string[]): string[] {
  if (values.length > 20) throw new BadRequestException('Use at most 20 root URLs');
  return [
    ...new Set(
      values.map((value) => {
        try {
          const url = new URL(value.trim());
          if (value.length > 4096 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
            throw new Error('Invalid root URL');
          return url.origin + url.pathname.replace(/\/+$/, '');
        } catch {
          throw new BadRequestException('Enter HTTPS root URLs without credentials, query parameters or fragments');
        }
      }),
    ),
  ].sort();
}

export function urlPrefixScore(value: string, prefix: string): number {
  try {
    const url = new URL(value);
    const root = new URL(prefix);
    if (url.username || url.password || url.origin !== root.origin) return -1;
    const path = root.pathname.replace(/\/+$/, '');
    return url.pathname === path || url.pathname.startsWith(path + '/') ? prefix.length : -1;
  } catch {
    return -1;
  }
}

export function candidateUrlPrefixFilter(urls: SQL, prefixes: string[]): SQL | undefined {
  if (!prefixes.length) return undefined;
  return sql`exists (select 1 from jsonb_array_elements(${urls}) as candidate_url where candidate_url->>'recognized' = 'true' and ${or(...prefixes.map((prefix) => sql`(candidate_url->>'canonicalUrl' = ${prefix} or starts_with(candidate_url->>'canonicalUrl', ${prefix + '/'}) or starts_with(candidate_url->>'canonicalUrl', ${prefix + '?'}) or starts_with(candidate_url->>'canonicalUrl', ${prefix + '#'}))`))})`;
}

import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { normalizeUrlPrefixes, urlPrefixScore } from './fanfiction-url-prefix';
import { ListFanfictionDiscoveryDto, SelectFanfictionDiscoveryDto } from './dto/fanfiction-discovery.dto';

describe('story root URL matching', () => {
  it('normalizes roots and matches only the same origin and path subtree', () => {
    const [root] = normalizeUrlPrefixes([' HTTPS://Example.com:443/fiction/ ', 'https://example.com/fiction']);
    expect(root).toBe('https://example.com/fiction');
    for (const url of ['https://example.com/fiction', 'https://example.com/fiction/123?x=1']) expect(urlPrefixScore(url, root!)).toBeGreaterThan(0);
    for (const url of [
      'https://example.com/fictional/1',
      'https://example.com.evil/fiction/1',
      'http://example.com/fiction/1',
      'https://user@example.com/fiction/1',
    ])
      expect(urlPrefixScore(url, root!)).toBe(-1);
  });
  it.each(['http://example.com', 'https://user:secret@example.com', 'https://example.com?a=1', 'https://example.com#part', 'not a URL'])(
    'rejects invalid roots: %s',
    (url) => {
      expect(() => normalizeUrlPrefixes([url])).toThrow();
    },
  );
  it('validates bounded filters in both query strings and selection requests', async () => {
    const query = plainToInstance(ListFanfictionDiscoveryDto, { urlPrefixes: 'https://example.com\nhttps://other.com' });
    expect(await validate(query)).toEqual([]);
    expect(query.urlPrefixes).toHaveLength(2);
    const selection = {
      idempotencyKey: 'd452f465-edda-4fd0-ae52-696bce547e4a',
      decision: 'approve',
      allMatching: true,
      autoProfile: true,
      urlPrefixes: Array(21).fill('https://example.com'),
    };
    expect((await validate(plainToInstance(SelectFanfictionDiscoveryDto, selection))).length).toBeGreaterThan(0);
  });
});

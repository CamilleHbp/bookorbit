import { describe, expect, it } from 'vitest';
import { configurationMatchesUrl } from './fanfiction-defaults';

describe('story source defaults', () => {
  it.each([
    ['[fiction.live]\n', 'https://beta.fiction.live/stories/a/id', true],
    ['[www.fanfiction.net]\n', 'https://m.fanfiction.net/s/123', true],
    ['[archiveofourown.org]\n', 'https://archiveofourown.org/works/12', true],
    ['[archiveofourown.org]\n', 'https://archiveofourown.org.evil.test/works/12', false],
    ['[defaults]\nusername: fiction.live\n', 'https://fiction.live/stories/a/id', false],
    ['[https://fiction.live/stories/a/id]\n', 'https://fiction.live/stories/a/id/home', true],
    ['[https://fiction.live/stories/a/id]\n', 'https://fiction.live/stories/a/id-other', false],
    ['[fiction.live]\n', 'https://user:password@fiction.live/story', false],
    ['[fiction.live]\n', 'https://', false],
  ])('matches only the configured source: %s, %s', (configuration, url, expected) => {
    expect(configurationMatchesUrl(configuration, url)).toBe(expected);
  });
});

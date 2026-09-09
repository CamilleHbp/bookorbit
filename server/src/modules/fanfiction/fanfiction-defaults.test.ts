import { describe, expect, it } from 'vitest';
import type { RequestUser } from '../../common/types/request-user';
import { configurationMatchesUrl, withFanfictionDefaults } from './fanfiction-defaults';

describe('story source defaults', () => {
  const user = (value?: boolean) => ({ settings: { fanfictionIsAdult: value } }) as RequestUser;
  it('allows adult public imports without a profile and preserves cookies', () => {
    const document = { configuration: '', cookies: [] };
    const result = withFanfictionDefaults(document, user(true));
    expect(result.configuration).toContain('[overrides]\nis_adult: true');
    expect(result.cookies).toBe(document.cookies);
    expect(document.configuration).toBe('');
  });
  it('applies the account preference over legacy settings without duplicate options', () => {
    const document = { configuration: '[fiction.live]\nis_adult: false\n[overrides]\nis_adult: false\ninclude_images: true\n', cookies: [] };
    const result = withFanfictionDefaults(document, user(true));
    expect(result.configuration).toContain('[overrides]\nis_adult: true\ninclude_images: true');
    expect(withFanfictionDefaults(result, user(true))).toEqual(result);
    expect(withFanfictionDefaults(result, user(false)).configuration).toContain('[overrides]\nis_adult: false');
    expect(withFanfictionDefaults(document, user())).toBe(document);
  });
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

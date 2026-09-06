import { describe, expect, it } from 'vitest';
import { mergeFanfictionCookies, redactFanfictionCookies } from './fanfiction-cookies';

const cookie = { name: 'session', value: 'private-cookie-value', domain: '.archiveofourown.org', path: '/', secure: true };
describe('profile cookie edits', () => {
  it('redacts cookie values and preserves unchanged values by domain, path and name', () => {
    const masked = redactFanfictionCookies([cookie]);
    expect(masked[0].value).toBe('********');
    expect(mergeFanfictionCookies([cookie], [{ ...masked[0], expires: 2_000_000_000 }])).toEqual([{ ...cookie, expires: 2_000_000_000 }]);
    expect(cookie.value).toBe('private-cookie-value');
  });
  it('distinguishes omitted cookies, explicit removal and explicit empty values', () => {
    expect(mergeFanfictionCookies([cookie])).toEqual([cookie]);
    expect(mergeFanfictionCookies([cookie], [])).toEqual([]);
    expect(mergeFanfictionCookies([cookie], [{ ...cookie, value: '' }])[0].value).toBe('');
  });
  it.each([{ domain: 'other.example' }, { path: '/other' }, { name: 'another-session' }])(
    'does not move masked credentials to a new identity',
    (change) => {
      expect(() => mergeFanfictionCookies([cookie], [{ ...cookie, ...change, value: '********' }])).toThrow('Enter a value');
    },
  );
  it('rejects duplicated identities while allowing separate paths and cookie names', () => {
    expect(() => mergeFanfictionCookies([], [cookie, { ...cookie, domain: cookie.domain.toUpperCase() }])).toThrow('unique');
    expect(mergeFanfictionCookies([], [cookie, { ...cookie, path: '/works' }])).toHaveLength(2);
    expect(() => mergeFanfictionCookies([], [{ ...cookie, value: '********' }])).toThrow('Enter a value');
  });
});

import { describe, expect, it } from 'vitest';
import { mergeFanfictionCookies, redactFanfictionCookies, mergeRenewedCookies, validateRuntimeCookies } from './fanfiction-cookies';

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

describe('renewed cookie merging', () => {
  it('combines renewals from separate sites without overwriting a newer value', () => {
    const other = { ...cookie, domain: 'other.example', value: 'other-old' };
    const current = [{ ...cookie, value: 'newer' }, other];
    const incoming = [
      { ...cookie, value: 'stale-renewal' },
      { ...other, value: 'other-new' },
    ];
    expect(mergeRenewedCookies([cookie, other], current, incoming)).toEqual([current[0], incoming[1]]);
  });
  it('retains concurrent additions and applies deletions only to unchanged cookies', () => {
    const additional = { ...cookie, name: 'new-session' };
    expect(mergeRenewedCookies([cookie], [cookie, additional], [])).toEqual([additional]);
    expect(mergeRenewedCookies([cookie], [{ ...cookie, value: 'newer' }], [])).toEqual([{ ...cookie, value: 'newer' }]);
    expect(mergeRenewedCookies([], [], [{ ...cookie, value: '********' }])).toEqual([{ ...cookie, value: '********' }]);
  });
  it.each([
    null,
    {},
    [null],
    [cookie, cookie],
    [{ ...cookie, value: 'injected\r\nheader' }],
    [{ ...cookie, extra: 'secret' }],
    Array(201).fill(cookie),
  ])('rejects invalid runtime jars', (value) => {
    expect(() => validateRuntimeCookies(value)).toThrow('runtime cookie');
  });
});

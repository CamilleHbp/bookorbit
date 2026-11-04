import { describe, expect, it } from 'vitest';
import { fanfictionWebsite } from './fanfiction-website';

describe('website sign-in capabilities', () => {
  it('offers ScribbleHub credentials with the normalized connection ID', () => {
    expect(
      fanfictionWebsite({ id: 'www.scribblehub.com', supportsPasswordLogin: true, examples: ['https://www.scribblehub.com/series/123/story/'] }),
    ).toEqual({
      id: 'scribblehub.com',
      name: 'ScribbleHub',
      access: 'login',
      examples: ['https://www.scribblehub.com/series/123/story/'],
    });
  });

  it('offers Royal Road email and password and respects capabilities for unlisted sites', () => {
    expect(fanfictionWebsite({ id: 'www.royalroad.com', supportsPasswordLogin: true, examples: [] })).toMatchObject({
      id: 'royalroad.com',
      access: 'login',
      usernameKind: 'email',
    });
    expect(fanfictionWebsite({ id: 'www.fimfiction.net', supportsPasswordLogin: true, examples: [] }).access).toBe('login');
    expect(fanfictionWebsite({ id: 'www.giantessworld.net', supportsPasswordLogin: true, examples: [] }).access).toBe('login');
  });

  it('keeps cookie-only websites from accepting unsupported passwords', () => {
    expect(fanfictionWebsite({ id: 'www.fanfiction.net', examples: [] }).access).toBe('cookies');
  });
});

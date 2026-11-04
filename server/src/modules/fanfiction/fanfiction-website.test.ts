import { describe, expect, it } from 'vitest';
import { fanfictionWebsite } from './fanfiction-website';

describe('website sign-in capabilities', () => {
  it('offers ScribbleHub credentials with the normalized connection ID', () => {
    expect(fanfictionWebsite({ id: 'www.scribblehub.com', examples: ['https://www.scribblehub.com/series/123/story/'] })).toEqual({
      id: 'scribblehub.com',
      name: 'ScribbleHub',
      access: 'login',
      examples: ['https://www.scribblehub.com/series/123/story/'],
    });
  });

  it('keeps cookie-only websites from accepting unsupported passwords', () => {
    expect(fanfictionWebsite({ id: 'www.fanfiction.net', examples: [] }).access).toBe('cookies');
  });
});

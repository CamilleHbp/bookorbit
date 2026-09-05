import { describe, expect, it } from 'vitest';
import { boundAnchorText, normalizeAnchorText, scalarLength } from './anchor-text';

describe('portable anchor text version 1', () => {
  it('collapses the defined whitespace identically around Unicode scalars', () => {
    expect(normalizeAnchorText('\t Café\u00a0\u2003😀\n\rchapter\u3000')).toBe('Café 😀 chapter');
    expect(normalizeAnchorText('e\u0301')).toBe('e\u0301');
  });
  it('counts and bounds excerpts without splitting surrogate pairs', () => {
    expect(scalarLength('a😀é')).toBe(3);
    expect(boundAnchorText('a😀é', 2)).toBe('a😀');
    expect(boundAnchorText('hello', 0)).toBe('');
  });
});

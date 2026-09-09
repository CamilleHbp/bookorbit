import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { normalizeAnchorTextWithOffsets } from '@bookorbit/types';
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

function luaString(value: string): string {
  return '"' + [...Buffer.from(value)].map((byte) => `\\${String(byte).padStart(3, '0')}`).join('') + '"';
}

const lua = process.env.LUAJIT_BIN ?? 'luajit';
const hasLua = spawnSync(lua, ['-v']).status === 0;

describe('normalized native locator mappings', () => {
  it('maps scalar offsets to original UTF-16 offsets', () => {
    expect(normalizeAnchorTextWithOffsets(' \tA😀\u00a0  é\n')).toEqual({
      text: 'A😀 é',
      nativeOffsets: [2, 3, 5, 8, 9, 10],
      truncated: false,
    });
    expect(normalizeAnchorTextWithOffsets('😀', 1)).toEqual({ text: '', nativeOffsets: [0], truncated: true });
    expect(() => normalizeAnchorTextWithOffsets('\ud800')).toThrow('unpaired surrogate');
  });

  it.skipIf(!hasLua)('agrees with Lua for Unicode and every versioned whitespace scalar', () => {
    const whitespace = [9, 10, 11, 12, 13, 32, 133, 160, 5760, ...Array.from({ length: 11 }, (_, i) => 8192 + i), 8232, 8233, 8239, 8287, 12288];
    const inputs = ['', 'é😀é', '\ufeff a', ...whitespace.map((code) => ` ${String.fromCodePoint(code)}A😀${String.fromCodePoint(code)}é `)];
    const module = resolve(import.meta.dirname, '../../../../koreader-plugin/bookorbit.koplugin/bookorbit_anchor_text.lua');
    const script = [
      `local m = dofile(${luaString(module)})`,
      ...inputs.map((input) => {
        const normalized = normalizeAnchorTextWithOffsets(input);
        const offsets = normalized.nativeOffsets.map((offset) => Buffer.byteLength(input.slice(0, offset))).join(',');
        return `local r = assert(m.normalize(${luaString(input)})); assert(r.text == ${luaString(normalized.text)}); assert(table.concat(r.nativeOffsets, ',') == ${luaString(offsets)}); assert(not r.truncated)`;
      }),
    ].join('\n');
    const result = spawnSync(lua, ['-e', script], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

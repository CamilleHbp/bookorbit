export const ANCHOR_TEXT_VERSION = 1;
export const ANCHOR_QUOTE_LIMIT = 256;
export const ANCHOR_CONTEXT_LIMIT = 128;

// Version 1 preserves Unicode scalars (no case folding or composition), collapses
// this fixed whitespace set, and expresses normalized offsets in scalar values.
const SPACES = new Set([32, 133, 160, 5760, 8232, 8233, 8239, 8287, 12288]);

export function normalizeAnchorText(text: string): string {
  let normalized = '';
  let pendingSpace = false;
  for (const scalar of text) {
    const code = scalar.codePointAt(0)!;
    if ((code >= 9 && code <= 13) || (code >= 8192 && code <= 8202) || SPACES.has(code)) {
      pendingSpace = normalized.length > 0;
    } else {
      if (pendingSpace) normalized += ' ';
      normalized += scalar;
      pendingSpace = false;
    }
  }
  return normalized;
}

export function scalarLength(text: string): number {
  let length = 0;
  for (const scalar of text) length += scalar.length > 0 ? 1 : 0;
  return length;
}

export function boundAnchorText(text: string, limit: number): string {
  let result = '';
  let count = 0;
  for (const scalar of text) {
    if (count++ >= limit) break;
    result += scalar;
  }
  return result;
}

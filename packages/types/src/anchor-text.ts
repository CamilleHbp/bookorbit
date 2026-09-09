export const ANCHOR_TEXT_VERSION = 1;
export const ANCHOR_QUOTE_LIMIT = 256;
export const ANCHOR_CONTEXT_LIMIT = 128;

// Version 1 preserves Unicode scalars (no case folding or composition), collapses
// this fixed whitespace set, and expresses normalized offsets in scalar values.
const SPACES = new Set([32, 133, 160, 5760, 8232, 8233, 8239, 8287, 12288]);

export function normalizeAnchorText(text: string): string {
  let normalized = "";
  let pendingSpace = false;
  for (const scalar of text) {
    const code = unicodeScalarCode(scalar);
    if ((code >= 9 && code <= 13) || (code >= 8192 && code <= 8202) || SPACES.has(code)) {
      pendingSpace = normalized.length > 0;
    } else {
      if (pendingSpace) normalized += " ";
      normalized += scalar;
      pendingSpace = false;
    }
  }
  return normalized;
}

export function scalarLength(text: string): number {
  let length = 0;
  for (const scalar of text) {
    unicodeScalarCode(scalar);
    length++;
  }
  return length;
}

export function boundAnchorText(text: string, limit: number): string {
  let result = "";
  let count = 0;
  for (const scalar of text) {
    if (count++ >= limit) break;
    unicodeScalarCode(scalar);
    result += scalar;
  }
  return result;
}

export interface NormalizedAnchorText {
  text: string;
  nativeOffsets: number[];
  truncated: boolean;
}

export function normalizeAnchorTextWithOffsets(text: string, maxNativeUnits = 1_000_000): NormalizedAnchorText {
  const output: string[] = [];
  const nativeOffsets: number[] = [];
  const budget = Number.isFinite(maxNativeUnits) ? Math.max(0, Math.floor(maxNativeUnits)) : 0;
  let nativeOffset = 0;
  let endOffset = 0;
  let spaceOffset: number | null = null;
  for (const scalar of text) {
    if (nativeOffset + scalar.length > budget) break;
    const code = unicodeScalarCode(scalar);
    if ((code >= 9 && code <= 13) || (code >= 8192 && code <= 8202) || SPACES.has(code)) {
      if (output.length && spaceOffset === null) spaceOffset = nativeOffset;
    } else {
      if (spaceOffset !== null) {
        output.push(" ");
        nativeOffsets.push(spaceOffset);
      }
      output.push(scalar);
      nativeOffsets.push(nativeOffset);
      spaceOffset = null;
      endOffset = nativeOffset + scalar.length;
    }
    nativeOffset += scalar.length;
  }
  nativeOffsets.push(endOffset);
  return { text: output.join(""), nativeOffsets, truncated: nativeOffset < text.length };
}

function unicodeScalarCode(scalar: string): number {
  const code = scalar.codePointAt(0)!;
  if (code >= 0xd800 && code <= 0xdfff) throw new RangeError("Anchor text contains an unpaired surrogate");
  return code;
}

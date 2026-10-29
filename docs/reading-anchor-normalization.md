# Reading anchor text, version 1

Anchors use Unicode scalar offsets. A supplementary character such as an emoji counts as one scalar. A combining mark counts separately. Case, punctuation, normalization form, and zero-width characters are preserved. Invalid Unicode input is rejected.

Collapse each consecutive sequence of the following code points to one U+0020 space, then remove leading and trailing collapsed spaces:

- U+0009 through U+000D
- U+0020, U+0085, U+00A0, U+1680
- U+2000 through U+200A
- U+2028, U+2029, U+202F, U+205F, U+3000

U+FEFF is preserved. Version 1 does not apply NFC, NFKC, case folding, or locale-sensitive transformations. Quotes contain at most 256 scalars; each context excerpt contains at most 128 scalars.

For EPUB manifests, parse chapter markup as HTML. Exclude `script`, `style`, `head`, and elements bearing `hidden`, including their descendants. Replace `br` with a space. Append a space to each `p`, `div`, `section`, `li`, and `h1` through `h6` before collecting body text in document order. CSS layout and generated content do not alter the manifest. A reader must independently verify the visible passage before claiming an exact native position.

Native mapping arrays contain one zero-based source offset for each normalized scalar plus an exclusive end offset. A collapsed space maps to the first source whitespace scalar in that sequence. The final offset excludes discarded trailing whitespace. Empty output maps to offset zero.

TypeScript source offsets count UTF-16 code units. Lua source offsets count UTF-8 bytes. These native units must never be exchanged as normalized offsets. For example, `A😀` contains two normalized scalars, three UTF-16 code units, and five UTF-8 bytes.

Mapped normalization is bounded to one million native units by default. Truncation never splits a Unicode scalar. A truncated index cannot establish that an absent passage does not exist; readers must use another verified index or an approximate location.

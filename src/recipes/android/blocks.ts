export interface BlockSpan {
  /** Index of the block-name token in the source. */
  readonly start: number;
  /** Index of the opening brace `{`. */
  readonly openBrace: number;
  /** Index of the matching closing brace `}`. */
  readonly closeBrace: number;
  /** Index just after the opening brace — start of the body. */
  readonly bodyStart: number;
  /** Index of the closing brace — exclusive end of the body. */
  readonly bodyEnd: number;
}

/**
 * Copy of `source` with comments and string literals blanked out (same
 * length; newlines kept) so brace/keyword scanning can't be fooled by them.
 * Handles `//`, `/* *\/`, '…', "…", and triple-quoted strings.
 *
 * With `keepStrings`, only comments are blanked and string literals stay
 * intact (still skipped, so `//` inside a string is not a comment) — use it
 * to match on plugin ids / artifact coordinates, which live in strings.
 */
export function maskCommentsAndStrings(source: string, keepStrings = false): string {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    const three = source.slice(i, i + 3);
    if (two === '//') {
      let end = source.indexOf('\n', i);
      if (end === -1) end = source.length;
      blank(i, end);
      i = end;
    } else if (two === '/*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : close + 2;
      blank(i, end);
      i = end;
    } else if (three === '"""' || three === "'''") {
      const close = source.indexOf(three, i + 3);
      const end = close === -1 ? source.length : close + 3;
      if (!keepStrings) blank(i, end);
      i = end;
    } else if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== quote && source[j] !== '\n') {
        j += source[j] === '\\' ? 2 : 1;
      }
      const end = Math.min(source.length, j + 1);
      if (!keepStrings) blank(i, end);
      i = end;
    } else {
      i++;
    }
  }
  return out.join('');
}

export function findMatchingBrace(s: string, openIdx: number): number | null {
  if (s[openIdx] !== '{') return null;
  let depth = 1;
  for (let i = openIdx + 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * Locate a top-level Gradle DSL block by name.
 *
 * Comments and string literals are ignored (matching runs on a masked copy),
 * so a `plugins {` or a stray brace inside them is never picked up. With
 * `topLevel`, only a block at brace depth 0 matches (use for blocks Gradle
 * defines at script level, e.g. `plugins`).
 *
 * Searches for `<blockName>(...optional args...) {` followed by balanced braces.
 */
export function findBlock(
  source: string,
  blockName: string,
  options: { readonly topLevel?: boolean } = {},
): BlockSpan | null {
  const masked = maskCommentsAndStrings(source);
  const re = new RegExp(`(?<![\\w.])${escapeRegex(blockName)}\\s*(?:\\([^)]*\\)\\s*)?\\{`, 'g');
  let depth = 0;
  let scanned = 0;
  for (const match of masked.matchAll(re)) {
    const matchStart = match.index;
    if (matchStart === undefined) continue;
    if (options.topLevel) {
      for (; scanned < matchStart; scanned++) {
        if (masked[scanned] === '{') depth++;
        else if (masked[scanned] === '}') depth--;
      }
      if (depth !== 0) continue;
    }
    const openBrace = matchStart + match[0].length - 1;
    const closeBrace = findMatchingBrace(masked, openBrace);
    if (closeBrace === null) continue;
    return {
      start: matchStart,
      openBrace,
      closeBrace,
      bodyStart: openBrace + 1,
      bodyEnd: closeBrace,
    };
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

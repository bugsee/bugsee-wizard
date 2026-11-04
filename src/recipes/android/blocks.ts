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
 * Naive — assumes braces in strings/comments don't appear. Good enough for
 * settings.gradle and build.gradle files where this assumption holds.
 *
 * Searches for `<blockName>(...optional args...) {` followed by balanced braces.
 */
export function findBlock(source: string, blockName: string): BlockSpan | null {
  const re = new RegExp(`(?<![\\w.])${escapeRegex(blockName)}\\s*(?:\\([^)]*\\)\\s*)?\\{`, 'g');
  for (const match of source.matchAll(re)) {
    const matchStart = match.index;
    if (matchStart === undefined) continue;
    const openBrace = matchStart + match[0].length - 1;
    const closeBrace = findMatchingBrace(source, openBrace);
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

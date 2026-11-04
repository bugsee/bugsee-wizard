/**
 * Locate the body of a `target '<name>' do … end` block in a Podfile.
 *
 * Handles nested `do…end` (e.g. RN Podfiles where a Tests target is nested
 * inside the app target) by counting `do`/`end` token pairs. Skips tokens
 * that appear inside `# comments`, single-quoted, or double-quoted strings
 * — sufficient for Podfile syntax (full Ruby has more, but Podfiles don't
 * use heredocs or `%w` literals).
 *
 * Returns null when the named target isn't present.
 */
export interface TargetBlockSpan {
  /** Index of the first character of the matched `target` keyword. */
  readonly headerStart: number;
  /** Index just after the `do` keyword on the header line. */
  readonly bodyStart: number;
  /** Index of the matching `end` keyword (exclusive end of the body). */
  readonly bodyEnd: number;
  /** Index just after the `end` keyword. */
  readonly end: number;
}

const TOKEN_RE = /\bdo\b|\bend\b|#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

export function findTargetBlock(source: string, targetName: string): TargetBlockSpan | null {
  const escaped = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRe = new RegExp(`^[ \\t]*target\\s+['"]${escaped}['"]\\s+do\\b`, 'gm');
  const header = headerRe.exec(source);
  if (!header) return null;

  const headerStart = header.index;
  const bodyStart = headerStart + header[0].length;

  let depth = 1;
  TOKEN_RE.lastIndex = bodyStart;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((match = TOKEN_RE.exec(source))) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('"') || token.startsWith("'")) continue;
    if (token === 'do') {
      depth++;
    } else if (token === 'end') {
      depth--;
      if (depth === 0) {
        return {
          headerStart,
          bodyStart,
          bodyEnd: match.index,
          end: match.index + 3,
        };
      }
    }
  }
  return null;
}

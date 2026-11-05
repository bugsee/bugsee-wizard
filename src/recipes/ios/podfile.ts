/**
 * Locate the body of a `target '<name>' do … end` block in a Podfile.
 *
 * Handles nested `do…end` (e.g. RN Podfiles where a Tests target is nested
 * inside the app target) and Ruby's other `end`-terminated blocks
 * (`if`/`unless`/`case`/`begin`/`def`/`while`/…) by counting openers vs `end`. Skips tokens
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

// Block openers besides `do`: a keyword only opens a block (and so owns an
// `end`) at statement start or as an assignment's right-hand side; after an
// expression (`pod 'x' if cond`) it is a modifier and owns no `end`.
const OPENER = 'if|unless|case|begin|def|class|module|while|until|for';
const TOKEN_RE = new RegExp(
  `(?<![\\w.:@$])(?:(?<=^[ \\t]*)|(?<=[=(]\\s*))(?:${OPENER})\\b(?![?!:])|\\bdo\\b|\\bend\\b|#[^\\n]*|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'`,
  'gm',
);
const LOOP_OPENER = /^(?:while|until|for)$/;

export function findTargetBlock(source: string, targetName: string): TargetBlockSpan | null {
  const escaped = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRe = new RegExp(`^[ \\t]*target\\s+['"]${escaped}['"]\\s+do\\b`, 'gm');
  const header = headerRe.exec(source);
  if (!header) return null;

  const headerStart = header.index;
  const bodyStart = headerStart + header[0].length;

  let depth = 1;
  let loopDoUntil = -1;
  TOKEN_RE.lastIndex = bodyStart;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((match = TOKEN_RE.exec(source))) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('"') || token.startsWith("'")) continue;
    if (token === 'do') {
      // `while x do` / `for i in y do`: the `do` belongs to the loop
      // opener already counted on this line.
      if (match.index < loopDoUntil) {
        loopDoUntil = -1;
        continue;
      }
      depth++;
    } else if (token !== 'end') {
      depth++;
      if (LOOP_OPENER.test(token)) {
        const eol = source.indexOf('\n', match.index);
        loopDoUntil = eol === -1 ? source.length : eol;
      }
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

import { readFile, writeFile } from 'node:fs/promises';

/**
 * Position of the start of the line containing `idx` (the index just after
 * the previous `\n`, or 0 if `idx` is on the first line). Used by step
 * apply() functions so insertions land at column 0 of a line, which keeps
 * the strip-on-rollback regex symmetric with the apply.
 */
export function lineStartBefore(source: string, idx: number): number {
  let i = idx;
  while (i > 0 && source[i - 1] !== '\n') i--;
  return i;
}

/**
 * Where to insert a line-oriented block just before a closing brace at
 * `closeIdx`. When only whitespace precedes the brace on its line, the
 * block goes at column 0 of that line (`atLineStart`) or right before the
 * brace; when other text shares the line (`dependencies { a }`), the block
 * goes immediately before the brace behind a newline so it stays INSIDE the
 * block rather than landing before the whole line.
 */
export function closingBraceInsertion(
  source: string,
  closeIdx: number,
  atLineStart: boolean,
): { readonly at: number; readonly prefix: string } {
  const lineStart = lineStartBefore(source, closeIdx);
  if (source.slice(lineStart, closeIdx).trim() === '') {
    return { at: atLineStart ? lineStart : closeIdx, prefix: '' };
  }
  return { at: closeIdx, prefix: '\n' };
}

export async function readOrNull(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export async function writeIfChanged(p: string, contents: string): Promise<boolean> {
  const existing = await readOrNull(p);
  if (existing === contents) return false;
  await writeFile(p, contents);
  return true;
}

/**
 * Strip a `// bugsee:wizard:begin ... // bugsee:wizard:end` (or comment-style
 * equivalent) block from `source`. Returns the source unchanged if the markers
 * are not found. Used by step rollback paths.
 *
 * The regex eats leading whitespace on the BEGIN line and the trailing
 * newline on the END line so the marker block can be removed cleanly without
 * leaving a half-blank indented line behind. The newline that *precedes* the
 * BEGIN line is intentionally left in place — every step's apply() inserts
 * after an existing `\n`, so leaving that `\n` keeps the file consistent
 * with its pre-apply state.
 *
 * A block cannot span a second BEGIN marker: an orphaned BEGIN (its END
 * deleted by hand) is left alone instead of swallowing everything up to the
 * next block's END.
 */
export function stripMarkerBlock(source: string, beginMarker: string, endMarker: string): string {
  const re = new RegExp(
    `[ \\t]*${escapeRegex(beginMarker)}(?:(?!${escapeRegex(beginMarker)})[\\s\\S])*?${escapeRegex(endMarker)}[ \\t]*\\r?\\n?`,
    'g',
  );
  return source.replace(re, '');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

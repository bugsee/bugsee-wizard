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

function markerBlockRegex(beginMarker: string, endMarker: string): RegExp {
  return new RegExp(
    `[ \\t]*${escapeRegex(beginMarker)}(?:(?!${escapeRegex(beginMarker)})[\\s\\S])*?${escapeRegex(endMarker)}[ \\t]*\\r?\\n?`,
  );
}

/** The first marker block exactly as `stripMarkerBlock` would remove it, or null. */
export function findMarkerBlock(
  source: string,
  beginMarker: string,
  endMarker: string,
): string | null {
  return markerBlockRegex(beginMarker, endMarker).exec(source)?.[0] ?? null;
}

/**
 * Replace the first marker block (same extent `stripMarkerBlock` removes) with
 * `block`, in place. Returns the source unchanged when no block is present.
 */
export function replaceMarkerBlock(
  source: string,
  beginMarker: string,
  endMarker: string,
  block: string,
): string {
  return source.replace(markerBlockRegex(beginMarker, endMarker), () => block);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface XmlOpenTag {
  /** Index of the `<`. */
  readonly index: number;
  /** Index just past the closing `>`. */
  readonly end: number;
  /** The complete opening tag text, `<name … >` or `<name … />`. */
  readonly text: string;
  readonly name: string;
  /** Everything between the tag name and the closing `>` (or `/>`). */
  readonly attrs: string;
  readonly selfClosing: boolean;
}

/**
 * Every opening tag whose name is in `names`, in document order. The end of
 * a tag is found with a quote-aware scan, so a `>` inside an attribute value
 * (`android:label="A > B"`) does not end it. `<activity-alias>` is not
 * `<activity>`. A tag that is never terminated ends the scan.
 */
export function* findOpenTags(content: string, names: readonly string[]): Generator<XmlOpenTag> {
  const startRe = new RegExp(`<(${names.join('|')})(?![\\w-])`, 'g');
  let m = startRe.exec(content);
  while (m) {
    let quote: string | null = null;
    let close = -1;
    for (let i = m.index + m[0].length; i < content.length; i++) {
      const ch = content[i] as string;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        close = i;
        break;
      }
    }
    if (close < 0) return;
    const selfClosing = content[close - 1] === '/';
    yield {
      index: m.index,
      end: close + 1,
      text: content.slice(m.index, close + 1),
      name: m[1] as string,
      attrs: content.slice(m.index + m[0].length, selfClosing ? close - 1 : close),
      selfClosing,
    };
    startRe.lastIndex = close + 1;
    m = startRe.exec(content);
  }
}

/** The first opening tag named `name` (see {@link findOpenTags}), or null. */
export function findOpenTag(content: string, name: string): XmlOpenTag | null {
  for (const tag of findOpenTags(content, [name])) return tag;
  return null;
}

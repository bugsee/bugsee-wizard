/**
 * JavaScript source text without its comments, read once from left to right so string, template and
 * comment boundaries are respected (`'http://x'` keeps its `//`). Used where a note in a comment must
 * not be mistaken for code: static scans of imports and bundler configs. Regular-expression literals
 * are not understood; for the scans that use this, that only ever errs toward keeping text.
 */
export function stripJsComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source.charAt(i);
    const next = source.charAt(i + 1);
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? n : end;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && source.charAt(j) !== c) j += source.charAt(j) === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

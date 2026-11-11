/**
 * JavaScript source text without its comments, read once from left to right so string, template,
 * regular-expression and comment boundaries are respected (`'http://x'` keeps its `//`, `/\/*$/`
 * is a pattern, not a comment). Used where a note in a comment must not be mistaken for code:
 * static scans of imports and bundler configs.
 *
 * A `/` starts a regular expression when the last significant character before it cannot end an
 * expression (`(,=:[!&|?{};` or the start of the text); anywhere else it is a division.
 */
export function stripJsComments(source: string): string {
  let out = '';
  let i = 0;
  let last = ''; // last significant (non-space, non-comment) character emitted
  const n = source.length;
  const REGEX_AFTER = '(,=:[!&|?{};+-*%<>~^';
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
      last = c;
    } else if (c === '/' && (last === '' || REGEX_AFTER.includes(last))) {
      // a regular expression literal: to the closing slash, skipping escapes and [classes]
      let j = i + 1;
      let inClass = false;
      while (j < n && source.charAt(j) !== '\n') {
        const d = source.charAt(j);
        if (d === '\\') j++;
        else if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j++;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      last = '/';
    } else {
      out += c;
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  return out;
}

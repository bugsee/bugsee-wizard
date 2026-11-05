import detectIndent from 'detect-indent';

/**
 * Serialize `value` in the style of the `original` file text: its indent unit (2 spaces by
 * default), its line endings (CRLF stays CRLF) and its trailing newline. The one place JSON
 * files the wizard rewrites get their formatting back, so edits never normalize EOLs.
 */
export function stringifyLike(value: unknown, original: string): string {
  const indent = detectIndent(original).indent || '  ';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const out = JSON.stringify(value, null, indent).replace(/\n/g, eol);
  return /\r?\n$/.test(original) ? out + eol : out;
}

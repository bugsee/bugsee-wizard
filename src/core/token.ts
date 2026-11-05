/**
 * Validate a Bugsee app token as typed or supplied. Trims first; a token is
 * alphanumeric with `.`, `_`, `-` permitted, so quotes/whitespace/shell
 * characters that got pasted along with it are rejected instead of being
 * written into project files. Returns an error message, or undefined if OK.
 */
export function validateAppToken(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return 'Token is required';
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return 'Tokens are alphanumeric (with `.`, `_`, `-` permitted) — looks like extra characters got pasted';
  }
  return undefined;
}

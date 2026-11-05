import { unlink, writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { readOrNull } from '../io.js';
import { type AndroidContext, TOKEN_PROPERTY_KEY } from '../types.js';

const TOKEN_LINE_RE = new RegExp(`^${TOKEN_PROPERTY_KEY.replace(/\./g, '\\.')}\\s*=`, 'm');
const TOKEN_VALUE_RE = new RegExp(`^${TOKEN_PROPERTY_KEY.replace(/\./g, '\\.')}\\s*=(.*)$`, 'm');

// Ownership marker, same idea as ensureGitignoredStep: a comment line right
// above the token line we wrote. When we replaced a user's own token the
// marker also carries the original line so rollback can restore it.
const MARKER = '# bugsee:wizard';
const MARKER_RE = /^#\s*bugsee:wizard(?: (replaced|removed): (.*?))?\r?$/;

/** The stored token (trimmed; tolerates CRLF), or null when no token line exists. */
function storedToken(content: string): string | null {
  const m = TOKEN_VALUE_RE.exec(content);
  return m ? (m[1] ?? '').trim() : null;
}

/**
 * Write the app token to `<root>/bugsee.properties`. Dedicated file so the
 * Gradle plugin can read it directly for build-time concerns (mapping
 * upload, NDK symbols, size analysis) without the wizard having to inject
 * a Gradle loader for those use-cases — the plugin owns its own resolver
 * chain. The wizard's loader only runs in automatic init mode, where it
 * pulls the same value into a `bugseeAppToken` Gradle variable for the
 * manifest placeholder substitution.
 */
export const writeBugseePropertiesStep: Step<AndroidContext> = {
  id: 'android.write-bugsee-properties',
  title: 'Write app token to bugsee.properties',

  async precheck(ctx): Promise<StepStatus> {
    const content = await readOrNull(ctx.androidPaths.bugseeProperties);
    const stored = content === null ? null : storedToken(content);
    if (stored === null) return { kind: 'pending' };
    // A different stored token (wrong/staging paste, re-run with the right
    // one) must be replaced, not silently kept. With no supplied token there
    // is nothing to compare against.
    const supplied = ctx.tokens.android?.trim();
    return supplied && supplied !== stored ? { kind: 'pending' } : { kind: 'satisfied' };
  },

  async apply(ctx) {
    const token = ctx.tokens.android;
    if (!token) {
      throw new Error('Android app token not provided in wizard context');
    }
    const existing = (await readOrNull(ctx.androidPaths.bugseeProperties)) ?? '';
    if (TOKEN_LINE_RE.test(existing)) {
      // Replace the first token line in place; drop any duplicates.
      let replaced = false;
      const lines: string[] = [];
      for (const line of existing.split('\n')) {
        if (!TOKEN_LINE_RE.test(line)) {
          lines.push(line);
        } else if (replaced) {
          // Duplicate: keep its place as a comment so rollback can restore it.
          const cr = line.endsWith('\r') ? '\r' : '';
          lines.push(`${MARKER} removed: ${line.replace(/\r$/, '')}${cr}`);
        } else {
          // Keep the line's own ending (a CRLF file stays CRLF).
          const cr = line.endsWith('\r') ? '\r' : '';
          // Mark ownership unless an earlier run already did; remember the
          // user's original line so rollback can put it back.
          const prev = lines[lines.length - 1];
          if (prev === undefined || !MARKER_RE.test(prev)) {
            lines.push(`${MARKER} replaced: ${line.replace(/\r$/, '')}${cr}`);
          }
          lines.push(`${TOKEN_PROPERTY_KEY}=${token}${cr}`);
          replaced = true;
        }
      }
      await writeFile(ctx.androidPaths.bugseeProperties, lines.join('\n'));
      return;
    }
    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    const sep = existing.length > 0 && !existing.endsWith('\n') ? eol : '';
    const updated = `${existing}${sep}${MARKER}${eol}${TOKEN_PROPERTY_KEY}=${token}${eol}`;
    await writeFile(ctx.androidPaths.bugseeProperties, updated);
  },

  async rollback(ctx) {
    const file = ctx.androidPaths.bugseeProperties;
    const content = await readOrNull(file);
    if (content === null) return;
    const lines = content.split('\n');
    const out: string[] = [];
    let touched = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      const m = MARKER_RE.exec(line);
      const next = lines[i + 1];
      const cr = line.endsWith('\r') ? '\r' : '';
      if (m?.[1] === 'removed') {
        // A duplicate we dropped at apply time: put it back where it was.
        out.push(`${m[2]}${cr}`);
        touched = true;
      } else if (m && next !== undefined && TOKEN_LINE_RE.test(next)) {
        // Wizard-written entry: drop it, restoring the user's original line.
        if (m[1] === 'replaced') out.push(`${m[2]}${cr}`);
        i++;
        touched = true;
      } else {
        out.push(line);
      }
    }
    if (!touched && !content.split('\n').some((l) => MARKER_RE.test(l))) {
      // Legacy install (earlier wizard version wrote no marker): only remove
      // the line when it is exactly what this run would have written.
      const supplied = ctx.tokens.android?.trim();
      if (!supplied || storedToken(content) !== supplied) return;
      out.length = 0;
      let dropped = false;
      for (const line of lines) {
        if (!dropped && TOKEN_LINE_RE.test(line)) dropped = true;
        else out.push(line);
      }
      touched = true;
    }
    if (!touched) return;
    const updated = out.join('\n');
    if (updated.trim() === '') await unlink(file);
    else await writeFile(file, updated);
  },
};

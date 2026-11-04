import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { readOrNull } from '../io.js';
import { type AndroidContext, TOKEN_PROPERTY_KEY } from '../types.js';

const TOKEN_LINE_RE = new RegExp(`^${TOKEN_PROPERTY_KEY.replace(/\./g, '\\.')}\\s*=`, 'm');
const TOKEN_VALUE_RE = new RegExp(`^${TOKEN_PROPERTY_KEY.replace(/\./g, '\\.')}\\s*=(.*)$`, 'm');

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
        } else if (!replaced) {
          lines.push(`${TOKEN_PROPERTY_KEY}=${token}`);
          replaced = true;
        }
      }
      await writeFile(ctx.androidPaths.bugseeProperties, lines.join('\n'));
      return;
    }
    const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    const updated = `${existing}${sep}${TOKEN_PROPERTY_KEY}=${token}\n`;
    await writeFile(ctx.androidPaths.bugseeProperties, updated);
  },

  async rollback(ctx) {
    const content = await readOrNull(ctx.androidPaths.bugseeProperties);
    if (content === null) return;
    const updated = content
      .split('\n')
      .filter((line) => !TOKEN_LINE_RE.test(line))
      .join('\n');
    await writeFile(ctx.androidPaths.bugseeProperties, updated);
  },
};

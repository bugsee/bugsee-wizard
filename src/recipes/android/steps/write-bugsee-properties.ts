import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { readOrNull } from '../io.js';
import { type AndroidContext, TOKEN_PROPERTY_KEY } from '../types.js';

const TOKEN_LINE_RE = new RegExp(`^${TOKEN_PROPERTY_KEY.replace(/\./g, '\\.')}\\s*=`, 'm');

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
    if (content !== null && TOKEN_LINE_RE.test(content)) {
      return { kind: 'satisfied' };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const token = ctx.tokens.android;
    if (!token) {
      throw new Error('Android app token not provided in wizard context');
    }
    const existing = (await readOrNull(ctx.androidPaths.bugseeProperties)) ?? '';
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

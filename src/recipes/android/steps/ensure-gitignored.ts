import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { readOrNull } from '../io.js';
import { type AndroidContext, PROPERTIES_FILE_NAME } from '../types.js';

const GITIGNORE_LINE_RE = new RegExp(
  `^\\s*${PROPERTIES_FILE_NAME.replace(/\./g, '\\.')}\\s*$`,
  'm',
);

/**
 * Ensure `bugsee.properties` is listed in `.gitignore`. The token lives in
 * that file in plain text — leaving it out of `.gitignore` would silently
 * leak it on the next commit. Idempotent (sniff for an existing line);
 * rollback removes the line we added if we recognise it as ours.
 */
export const ensureGitignoredStep: Step<AndroidContext> = {
  id: 'android.ensure-gitignored',
  title: `Ensure ${PROPERTIES_FILE_NAME} is in .gitignore`,

  async precheck(ctx): Promise<StepStatus> {
    const content = await readOrNull(ctx.androidPaths.gitignore);
    if (content !== null && GITIGNORE_LINE_RE.test(content)) {
      return { kind: 'satisfied' };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const existing = (await readOrNull(ctx.androidPaths.gitignore)) ?? '';
    const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    // A short marker comment lets rollback recognise the line as
    // wizard-added without depending on textual position alone. Users
    // who manually re-add `bugsee.properties` to `.gitignore` won't
    // have the marker, so rollback won't strip their entry.
    const updated = `${existing}${sep}# bugsee:wizard\n${PROPERTIES_FILE_NAME}\n`;
    await writeFile(ctx.androidPaths.gitignore, updated);
  },

  async rollback(ctx) {
    const content = await readOrNull(ctx.androidPaths.gitignore);
    if (content === null) return;
    // Walk lines and drop the `# bugsee:wizard` marker plus the immediately
    // following `bugsee.properties` line. This leaves user-managed entries
    // for `bugsee.properties` (without the marker) untouched, and preserves
    // the file's original surrounding whitespace.
    const lines = content.split('\n');
    const out: string[] = [];
    let skipNext = false;
    for (const line of lines) {
      if (skipNext) {
        skipNext = false;
        if (line.trim() === PROPERTIES_FILE_NAME) continue;
        out.push(line);
        continue;
      }
      if (/^\s*#\s*bugsee:wizard\s*$/.test(line)) {
        skipNext = true;
        continue;
      }
      out.push(line);
    }
    const updated = out.join('\n');
    if (updated !== content) {
      await writeFile(ctx.androidPaths.gitignore, updated);
    }
  },
};

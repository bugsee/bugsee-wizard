import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { readOrNull, stripMarkerBlock } from '../io.js';
import {
  type AndroidContext,
  type AndroidOptions,
  EXT_BLOCK_MARKER_BEGIN,
  EXT_BLOCK_MARKER_END,
  type GradleDsl,
} from '../types.js';

/**
 * Generate the `bugsee { ... }` Gradle block. Token is intentionally NOT
 * emitted here — the plugin reads it from `bugsee.properties` via its
 * `BugseePropertiesResolver` (build-time concern). The block is purely
 * structural toggles. Power users can still drop a manual `appToken("…")`
 * line inside this block; the plugin's resolver chain prefers DSL over
 * properties so the manual override works.
 */
function bugseeBlock(dsl: GradleDsl, opts: AndroidOptions): string {
  const lines: string[] = ['bugsee {'];
  if (dsl === 'kotlin') {
    if (opts.ndk) lines.push('    ndk(true)');
    if (opts.feedback) lines.push('    feedback(true)');
    if (opts.sizeAnalysis) {
      lines.push('    sizeAnalysis {');
      lines.push('        enabled.set(true)');
      lines.push('    }');
    }
  } else {
    if (opts.ndk) lines.push('    ndk true');
    if (opts.feedback) lines.push('    feedback true');
    if (opts.sizeAnalysis) {
      lines.push('    sizeAnalysis {');
      lines.push('        enabled.set(true)');
      lines.push('    }');
    }
  }
  lines.push('}');
  return `${EXT_BLOCK_MARKER_BEGIN}
${lines.join('\n')}
${EXT_BLOCK_MARKER_END}
`;
}

export const configureBugseeBlockStep: Step<AndroidContext> = {
  id: 'android.configure-bugsee-block',
  title: 'Add bugsee {} configuration block',

  async precheck(ctx): Promise<StepStatus> {
    const content = await readOrNull(ctx.androidPaths.appBuildGradle);
    if (content === null) {
      return { kind: 'blocked', reason: `${ctx.androidPaths.appBuildGradle} not found` };
    }
    return content.includes(EXT_BLOCK_MARKER_BEGIN) ? { kind: 'satisfied' } : { kind: 'pending' };
  },

  async apply(ctx) {
    const original = (await readOrNull(ctx.androidPaths.appBuildGradle)) ?? '';
    const block = bugseeBlock(ctx.androidPaths.appBuildGradleDsl, ctx.androidOptions);
    // Append the block at column 0 of a new line. If the original lacks a
    // trailing newline, add exactly one so the BEGIN marker starts a line —
    // any more would leave a stray blank line behind on rollback.
    const sep = original.length > 0 && !original.endsWith('\n') ? '\n' : '';
    const updated = `${original}${sep}${block}`;
    await writeFile(ctx.androidPaths.appBuildGradle, updated);
  },

  async rollback(ctx) {
    const content = await readOrNull(ctx.androidPaths.appBuildGradle);
    if (content === null) return;
    const stripped = stripMarkerBlock(content, EXT_BLOCK_MARKER_BEGIN, EXT_BLOCK_MARKER_END);
    if (stripped !== content) {
      await writeFile(ctx.androidPaths.appBuildGradle, stripped);
    }
  },
};

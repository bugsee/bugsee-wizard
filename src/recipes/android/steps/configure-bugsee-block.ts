import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { findMarkerBlock, readOrNull, replaceMarkerBlock, stripMarkerBlock } from '../io.js';
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

/**
 * Pre-apply content of files this step rewrote in place, per run context, so
 * rollback restores the original rather than just stripping the (possibly
 * previously-installed) block.
 */
const originals = new WeakMap<object, Map<string, string>>();

function remember(ctx: object, file: string, content: string): void {
  const m = originals.get(ctx) ?? new Map<string, string>();
  originals.set(ctx, m);
  if (!m.has(file)) m.set(file, content);
}

export const configureBugseeBlockStep: Step<AndroidContext> = {
  id: 'android.configure-bugsee-block',
  title: 'Add bugsee {} configuration block',

  async precheck(ctx): Promise<StepStatus> {
    const content = await readOrNull(ctx.androidPaths.appBuildGradle);
    if (content === null) {
      return { kind: 'blocked', reason: `${ctx.androidPaths.appBuildGradle} not found` };
    }
    if (!content.includes(EXT_BLOCK_MARKER_BEGIN)) return { kind: 'pending' };
    const expected = bugseeBlock(ctx.androidPaths.appBuildGradleDsl, ctx.androidOptions);
    const existing = findMarkerBlock(content, EXT_BLOCK_MARKER_BEGIN, EXT_BLOCK_MARKER_END);
    // Marker-owned block with different answers: update in place on re-run.
    return existing === expected ? { kind: 'satisfied' } : { kind: 'pending' };
  },

  async apply(ctx) {
    const original = (await readOrNull(ctx.androidPaths.appBuildGradle)) ?? '';
    const block = bugseeBlock(ctx.androidPaths.appBuildGradleDsl, ctx.androidOptions);
    // Append the block at column 0 of a new line. If the original lacks a
    // trailing newline, add exactly one so the BEGIN marker starts a line —
    // any more would leave a stray blank line behind on rollback.
    if (original.includes(EXT_BLOCK_MARKER_BEGIN)) {
      const replaced = replaceMarkerBlock(
        original,
        EXT_BLOCK_MARKER_BEGIN,
        EXT_BLOCK_MARKER_END,
        block,
      );
      remember(ctx, ctx.androidPaths.appBuildGradle, original);
      await writeFile(ctx.androidPaths.appBuildGradle, replaced);
      return;
    }
    const sep = original.length > 0 && !original.endsWith('\n') ? '\n' : '';
    const updated = `${original}${sep}${block}`;
    await writeFile(ctx.androidPaths.appBuildGradle, updated);
  },

  async rollback(ctx) {
    const saved = originals.get(ctx)?.get(ctx.androidPaths.appBuildGradle);
    if (saved !== undefined) {
      originals.get(ctx)?.delete(ctx.androidPaths.appBuildGradle);
      await writeFile(ctx.androidPaths.appBuildGradle, saved);
      return;
    }
    const content = await readOrNull(ctx.androidPaths.appBuildGradle);
    if (content === null) return;
    const stripped = stripMarkerBlock(content, EXT_BLOCK_MARKER_BEGIN, EXT_BLOCK_MARKER_END);
    if (stripped !== content) {
      await writeFile(ctx.androidPaths.appBuildGradle, stripped);
    }
  },
};

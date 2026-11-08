import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import {
  findMarkerBlock,
  readOrNull,
  rememberOriginal,
  replaceMarkerBlock,
  stripMarkerBlock,
} from '../io.js';
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

const SIZE_ANALYSIS_RE = /^[ \t]*sizeAnalysis[ \t]*\{\s*enabled\.set\(true\)\s*\}[ \t]*\r?\n?/m;
const NDK_RE = /^[ \t]*ndk(?:\(true\)|[ \t]+true)[ \t]*\r?\n?/m;
const FEEDBACK_RE = /^[ \t]*feedback(?:\(true\)|[ \t]+true)[ \t]*\r?\n?/m;

/** The answers an existing marker block encodes (whitespace, CRLF and extra user lines are irrelevant). */
function answersIn(block: string): { ndk: boolean; feedback: boolean; sizeAnalysis: boolean } {
  return {
    ndk: NDK_RE.test(block),
    feedback: FEEDBACK_RE.test(block),
    sizeAnalysis: SIZE_ANALYSIS_RE.test(block),
  };
}

/** Lines the user added inside the block (everything the wizard does not generate). */
function userLinesIn(block: string): string[] {
  const inner = block
    .replace(EXT_BLOCK_MARKER_BEGIN, '')
    .replace(EXT_BLOCK_MARKER_END, '')
    .replace(SIZE_ANALYSIS_RE, '')
    .replace(NDK_RE, '')
    .replace(FEEDBACK_RE, '');
  const lines = inner.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  // Drop the wrapper `bugsee {` first line and its closing `}` (last non-blank line).
  const first = lines.findIndex((l) => /^\s*bugsee\s*\{\s*$/.test(l));
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? '').trim() !== '') {
      last = i;
      break;
    }
  }
  if (first === -1 || last <= first) return [];
  return lines.slice(first + 1, last).filter((l) => l.trim() !== '');
}

/** The generated block with the user's own lines kept, in the file's line-ending style. */
function mergedBlock(existing: string, generated: string): string {
  const extra = userLinesIn(existing);
  let out = generated;
  if (extra.length > 0) {
    const close = out.lastIndexOf('\n}\n');
    out = `${out.slice(0, close + 1)}${extra.join('\n')}\n${out.slice(close + 1)}`;
  }
  return /\r\n/.test(existing) ? out.replace(/\r?\n/g, '\r\n') : out;
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
    const existing = findMarkerBlock(content, EXT_BLOCK_MARKER_BEGIN, EXT_BLOCK_MARKER_END);
    if (existing === null) {
      return {
        kind: 'blocked',
        reason: `${ctx.androidPaths.appBuildGradle} has a "${EXT_BLOCK_MARKER_BEGIN}" marker without its end marker; fix or remove it and re-run`,
      };
    }
    // Compare the answers, not the bytes: user-added lines, indentation and
    // CRLF must not make a re-run with identical answers rewrite the block.
    const want = answersIn(bugseeBlock(ctx.androidPaths.appBuildGradleDsl, ctx.androidOptions));
    const have = answersIn(existing);
    return want.ndk === have.ndk &&
      want.feedback === have.feedback &&
      want.sizeAnalysis === have.sizeAnalysis
      ? { kind: 'satisfied' }
      : { kind: 'pending' };
  },

  async apply(ctx) {
    const original = (await readOrNull(ctx.androidPaths.appBuildGradle)) ?? '';
    const block = bugseeBlock(ctx.androidPaths.appBuildGradleDsl, ctx.androidOptions);
    // Append the block at column 0 of a new line. If the original lacks a
    // trailing newline, add exactly one so the BEGIN marker starts a line —
    // any more would leave a stray blank line behind on rollback.
    if (original.includes(EXT_BLOCK_MARKER_BEGIN)) {
      const existing = findMarkerBlock(original, EXT_BLOCK_MARKER_BEGIN, EXT_BLOCK_MARKER_END);
      if (existing === null) {
        throw new Error(
          `${EXT_BLOCK_MARKER_BEGIN} marker without its end marker in ${ctx.androidPaths.appBuildGradle}`,
        );
      }
      const replaced = replaceMarkerBlock(
        original,
        EXT_BLOCK_MARKER_BEGIN,
        EXT_BLOCK_MARKER_END,
        mergedBlock(existing, block),
      );
      rememberOriginal(originals, ctx, ctx.androidPaths.appBuildGradle, original);
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

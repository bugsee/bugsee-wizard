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

interface ParsedBlock {
  /** Lines before the `bugsee {` line (inside the markers). */
  readonly before: string[];
  /** Lines between `bugsee {` and its own closing `}` (depth-matched). */
  readonly inner: string[];
  /** Lines after the closing `}` (inside the markers). */
  readonly after: string[];
}

/** Net `{` minus `}` on a line, ignoring braces inside string literals and comments. */
const braceDelta = (raw: string): number => {
  const line = raw
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/\/\/.*$/, '');
  return (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
};

/** Split a marker block into the user's text around `bugsee { … }` and its contents, by brace depth. */
function parseBlock(block: string): ParsedBlock {
  const lines = block
    .split(/\r?\n/)
    .filter((l) => !l.includes(EXT_BLOCK_MARKER_BEGIN) && !l.includes(EXT_BLOCK_MARKER_END))
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');
  const open = lines.findIndex((l) => /^\s*bugsee\s*\{/.test(l));
  if (open === -1) return { before: [], inner: [], after: lines };
  let depth = 0;
  let close = -1;
  for (let i = open; i < lines.length; i++) {
    depth += braceDelta(lines[i] ?? '');
    if (depth <= 0) {
      close = i;
      break;
    }
  }
  if (close === -1) return { before: [], inner: [], after: lines };
  return {
    before: lines.slice(0, open),
    inner: lines.slice(open + 1, close),
    after: lines.slice(close + 1),
  };
}

const headOf = (line: string): string => /^\s*([A-Za-z_]\w*)/.exec(line)?.[1] ?? '';

/** Toggles by leading token (`ndk true`, `ndk(false)`, `ndk = true` are all the ndk toggle). */
const TOGGLES = ['ndk', 'feedback', 'sizeAnalysis'] as const;

/** Inner lines grouped by toggle (a toggle's lines include its depth-matched `{ … }` body); the rest are the user's. */
function splitInner(inner: string[]): { toggles: Map<string, string>; other: string[] } {
  const toggles = new Map<string, string>();
  const other: string[] = [];
  for (let i = 0; i < inner.length; i++) {
    const line = inner[i] ?? '';
    const head = headOf(line);
    if (!(TOGGLES as readonly string[]).includes(head)) {
      other.push(line);
      continue;
    }
    let text = line;
    let depth = braceDelta(line);
    while (depth > 0 && i + 1 < inner.length) {
      i++;
      text += `\n${inner[i] ?? ''}`;
      depth += braceDelta(inner[i] ?? '');
    }
    toggles.set(head, `${toggles.get(head) ?? ''}${text}\n`);
  }
  return { toggles, other };
}

/** The answers an existing marker block encodes (whitespace, CRLF and extra user lines are irrelevant). */
function answersIn(block: string): { ndk: boolean; feedback: boolean; sizeAnalysis: boolean } {
  const { toggles } = splitInner(parseBlock(block).inner);
  const on = (t: string | undefined): boolean =>
    t !== undefined && /\btrue\b|\.set\(true\)/.test(t);
  const enabled = toggles.get('sizeAnalysis');
  return {
    ndk: on(toggles.get('ndk')) && !/\bfalse\b/.test(toggles.get('ndk') ?? ''),
    feedback: on(toggles.get('feedback')) && !/\bfalse\b/.test(toggles.get('feedback') ?? ''),
    sizeAnalysis: enabled !== undefined && /enabled(\.set\(true\)|\s*=\s*true)/.test(enabled),
  };
}

/**
 * The generated block with everything of the user's kept: text before and after
 * `bugsee { … }`, non-toggle lines inside it, and every toggle whose answer did not
 * change (so a user-extended `sizeAnalysis { … }` survives an unrelated change). Only
 * a toggle whose answer changed is regenerated or dropped. Uses the file's line-ending style.
 */
function mergedBlock(existing: string, generated: string): string {
  const { before, inner, after } = parseBlock(existing);
  const { toggles: have, other } = splitInner(inner);
  const want = splitInner(parseBlock(generated).inner).toggles;
  const haveAnswers = answersIn(existing);
  const wantAnswers = answersIn(generated);
  const toggleLines: string[] = [];
  for (const t of TOGGLES) {
    const keep = haveAnswers[t] === wantAnswers[t] && have.has(t);
    const text = keep ? have.get(t) : want.get(t);
    if (text !== undefined) toggleLines.push(...text.split('\n').filter((l) => l !== ''));
  }
  const gen = generated.split(/\r?\n/).filter((l) => l !== '');
  const begin = gen[0] ?? '';
  const end = gen[gen.length - 1] ?? '';
  const open = (gen[1] ?? 'bugsee {').replace(/\s+$/, '');
  const out = [begin, ...before, open, ...toggleLines, ...other, '}', ...after, end].join('\n');
  const text = `${out}\n`;
  return /\r\n/.test(existing) ? text.replace(/\r?\n/g, '\r\n') : text;
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
    if (original.includes(EXT_BLOCK_MARKER_BEGIN)) {
      // Re-run: update the marker-owned block in place, keeping the user's own text.
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
    // Append the block at column 0 of a new line. If the original lacks a
    // trailing newline, add exactly one so the BEGIN marker starts a line —
    // any more would leave a stray blank line behind on rollback.
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

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

/** A line of the block: the text as written, and its code with comments and string literals blanked out. */
interface Line {
  readonly raw: string;
  readonly code: string;
}

interface ParsedBlock {
  /** Lines before the `bugsee {` line (inside the markers). */
  readonly before: string[];
  /** Lines between `bugsee {` and its own closing `}` (depth-matched). */
  readonly inner: Line[];
  /** Lines after the closing `}` (inside the markers). */
  readonly after: string[];
}

/** Blank out comments (block comments may span lines) and string literals, keeping the line structure. */
function codeLines(text: string): string[] {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, ' '));
  return noBlock
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (m) => ' '.repeat(m.length))
        .replace(/\/\/.*$/, ''),
    );
}

const braceDelta = (code: string): number =>
  (code.match(/\{/g)?.length ?? 0) - (code.match(/\}/g)?.length ?? 0);

/**
 * Split a marker block into the user's text around `bugsee { … }` and its contents, by
 * brace depth. Null when that cannot be done safely (no `bugsee {`, unbalanced, or the
 * whole block on one line): the caller must then not rewrite the block.
 */
function parseBlock(block: string): ParsedBlock | null {
  const raws = block.split(/\r?\n/);
  const codes = codeLines(block);
  const lines: Line[] = [];
  raws.forEach((raw, i) => {
    if (raw.includes(EXT_BLOCK_MARKER_BEGIN) || raw.includes(EXT_BLOCK_MARKER_END)) return;
    if (raw.trim() === '') return;
    lines.push({ raw: raw.replace(/\s+$/, ''), code: codes[i] ?? '' });
  });
  const open = lines.findIndex((l) => /^\s*bugsee\s*\{/.test(l.code));
  if (open === -1) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < lines.length; i++) {
    depth += braceDelta(lines[i]?.code ?? '');
    if (depth <= 0) {
      close = i;
      break;
    }
  }
  if (close <= open) return null;
  // Text on the `bugsee {` line after the brace, or on the closing line around the brace,
  // belongs to no part we could keep: refuse rather than drop it.
  const opener = lines[open]?.code ?? '';
  const closer = lines[close]?.code ?? '';
  if (/\{\s*\S/.test(opener.slice(opener.indexOf('{')))) return null;
  if (/\S\s*\}/.test(closer.slice(0, closer.lastIndexOf('}') + 1))) return null;
  if (/\S/.test(closer.slice(closer.lastIndexOf('}') + 1))) return null;
  return {
    before: lines.slice(0, open).map((l) => l.raw),
    inner: lines.slice(open + 1, close),
    after: lines.slice(close + 1).map((l) => l.raw),
  };
}

/** Open minus close of braces and parentheses, so `ndk(` / `false` / `)` groups as one toggle. */
const groupDelta = (code: string): number =>
  braceDelta(code) + (code.match(/\(/g)?.length ?? 0) - (code.match(/\)/g)?.length ?? 0);

const headOf = (code: string): string => /^\s*([A-Za-z_]\w*)/.exec(code)?.[1] ?? '';

/** Toggles by leading token (`ndk true`, `ndk(false)`, `ndk = true` are all the ndk toggle). */
const TOGGLES = ['ndk', 'feedback', 'sizeAnalysis'] as const;

interface ToggleText {
  /** As written (for output). */
  readonly raw: string;
  /** Comments and string literals blanked (for reading the answer). */
  readonly code: string;
}

/**
 * Inner lines grouped by toggle (a toggle's lines include its depth-matched `{ … }` body);
 * the rest are the user's. Only top-level lines can be toggles: a toggle-named line nested
 * inside a user's own block stays with that block.
 */
function splitInner(inner: Line[]): { toggles: Map<string, ToggleText>; other: string[] } {
  const toggles = new Map<string, ToggleText>();
  const other: string[] = [];
  for (let i = 0; i < inner.length; i++) {
    const line = inner[i] as Line;
    const isToggle = (TOGGLES as readonly string[]).includes(headOf(line.code));
    let raw = line.raw;
    let code = line.code;
    let depth = groupDelta(line.code);
    const rawLines = [raw];
    while (depth > 0 && i + 1 < inner.length) {
      i++;
      const next = inner[i] as Line;
      rawLines.push(next.raw);
      code += `\n${next.code}`;
      depth += groupDelta(next.code);
    }
    raw = rawLines.join('\n');
    if (!isToggle) {
      other.push(...rawLines);
      continue;
    }
    const head = headOf(line.code);
    const prev = toggles.get(head);
    toggles.set(head, {
      raw: `${prev?.raw ?? ''}${raw}\n`,
      code: `${prev?.code ?? ''}${code}\n`,
    });
  }
  return { toggles, other };
}

interface Answers {
  ndk: boolean;
  feedback: boolean;
  sizeAnalysis: boolean;
}

const ENABLED_ANY_RE = /\benabled(?:\.set\(\s*(?:true|false)\s*\)|\s*=\s*(?:true|false)\b)/;
const ENABLED_RE = /\benabled(?:\.set\(\s*true\s*\)|\s*=\s*true)/;

/** Whether the top-level `enabled` flag of a `sizeAnalysis` text is true. */
function sizeAnalysisOn(code: string | undefined): boolean {
  const hit = code === undefined ? null : topLevelEnabled(code);
  if (code === undefined || hit === null) return false;
  const line = code.split('\n')[hit.line] ?? '';
  return ENABLED_RE.test(line.slice(hit.index, hit.index + hit.length));
}

/** The answers an existing marker block encodes (whitespace, CRLF and extra user lines are irrelevant). */
function answersIn(block: string): Answers {
  const parsed = parseBlock(block);
  if (parsed === null) {
    // Unparseable shape (e.g. everything on one line): read the toggles from the code text.
    const code = codeLines(block).join('\n');
    return {
      ndk: /\bndk\s*(?:\(\s*true\s*\)|=?\s*true\b)/.test(code),
      feedback: /\bfeedback\s*(?:\(\s*true\s*\)|=?\s*true\b)/.test(code),
      sizeAnalysis: /\bsizeAnalysis\b[\s\S]*?enabled(?:\.set\(\s*true\s*\)|\s*=\s*true)/.test(code),
    };
  }
  const { toggles } = splitInner(parsed.inner);
  const flag = (t: ToggleText | undefined): boolean =>
    t !== undefined && /\btrue\b/.test(t.code) && !/\bfalse\b/.test(t.code);
  return {
    ndk: flag(toggles.get('ndk')),
    feedback: flag(toggles.get('feedback')),
    sizeAnalysis: sizeAnalysisOn(toggles.get('sizeAnalysis')?.code),
  };
}

/**
 * The top-level `enabled` flag of a `sizeAnalysis { … }` text: the first match sitting directly
 * inside its braces (not inside a nested user block). Positions are in `code` (comments blanked).
 */
function topLevelEnabled(code: string): { line: number; index: number; length: number } | null {
  let depth = 0;
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const re = new RegExp(ENABLED_ANY_RE.source, 'g');
    for (const m of line.matchAll(re)) {
      const before = line.slice(0, m.index);
      if (depth + groupDelta(before) === 1) return { line: i, index: m.index, length: m[0].length };
    }
    depth += groupDelta(line);
  }
  return null;
}

/**
 * Switching `sizeAnalysis` on or off keeps the user's own settings inside it: only the
 * `enabled` flag is flipped (the line is found in the code, so a comment naming `enabled`
 * is never edited). Undefined when there is no such line (use the generated text).
 */
function flippedSizeAnalysis(
  toggle: string,
  have: Map<string, ToggleText>,
  want: Answers,
): string | undefined {
  const text = have.get(toggle);
  if (toggle !== 'sizeAnalysis' || text === undefined) return undefined;
  const hit = topLevelEnabled(text.code);
  if (hit === null) return undefined;
  const raws = text.raw.split('\n');
  const raw = raws[hit.line] ?? '';
  const old = raw.slice(hit.index, hit.index + hit.length);
  raws[hit.line] =
    raw.slice(0, hit.index) +
    old.replace(/\b(?:true|false)\b/, String(want.sizeAnalysis)) +
    raw.slice(hit.index + hit.length);
  return raws.join('\n');
}

/**
 * The generated block with everything of the user's kept: text before and after
 * `bugsee { … }`, non-toggle lines inside it, and every toggle whose answer did not
 * change (so a user-extended `sizeAnalysis { … }` survives an unrelated change). Only
 * a toggle whose answer changed is regenerated or dropped. Uses the file's line-ending style.
 */
function mergedBlock(existing: string, generated: string): string {
  const parsed = parseBlock(existing);
  if (parsed === null) throw new Error('the bugsee {} block has a shape the wizard cannot update');
  const { before, inner, after } = parsed;
  const { toggles: have, other } = splitInner(inner);
  const want = splitInner(parseBlock(generated)?.inner ?? []).toggles;
  const haveAnswers = answersIn(existing);
  const wantAnswers = answersIn(generated);
  const toggleLines: string[] = [];
  for (const t of TOGGLES) {
    const keep = haveAnswers[t] === wantAnswers[t] && have.has(t);
    const text = keep
      ? have.get(t)?.raw
      : (flippedSizeAnalysis(t, have, wantAnswers) ?? want.get(t)?.raw);
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
    if (
      want.ndk === have.ndk &&
      want.feedback === have.feedback &&
      want.sizeAnalysis === have.sizeAnalysis
    ) {
      return { kind: 'satisfied' };
    }
    if (parseBlock(existing) === null) {
      return {
        kind: 'blocked',
        reason: `the bugsee {} block in ${ctx.androidPaths.appBuildGradle} has a shape the wizard cannot safely update (unbalanced braces or all on one line); change the toggles by hand`,
      };
    }
    return { kind: 'pending' };
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

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ApplyResult, ManualSnippet, Step, StepStatus } from '../../../core/step.js';
import { readOrNull } from '../../android/io.js';
import type { RnContext } from '../types.js';

/**
 * The Android edits a BARE React Native app needs for `@bugsee/react-native` (package README:
 * "Android source maps", "Android: Bugsee Gradle plugin"):
 *
 *   settings.gradle(.kts)   pluginManagement searches Maven Central (the plugin lives there)
 *   build.gradle(.kts)      `id 'com.bugsee.android.gradle' version '<pin>' apply false`
 *   app/build.gradle(.kts)  apply the plugin, `bugseeDir`, hermesCommand, NDK dependency,
 *                           `apply from: bugsee-sourcemaps.gradle`
 *   bugsee.properties       `app_token` + `plugin.ndk.enabled=true` (git-ignored)
 *
 * Every edit is reversible by marker: whole blocks sit between begin/end comments, single added
 * lines end in a `:line` comment, and a user line we had to rewrite is kept as an `:orig:N`
 * comment above its replacement. Rollback strips exactly those, so the original bytes return.
 * A file shape we cannot edit with certainty is never guessed at: the step hands the README
 * snippet back as a manual instruction instead.
 */

const MARK = 'bugsee:wizard:rn-gradle';
const BEGIN = `${MARK}:begin`;
const END = `${MARK}:end`;
const LINE = `${MARK}:line`;
const ORIG = `${MARK}:orig`;

const PLUGIN_ID = 'com.bugsee.android.gradle';
const NDK_ARTIFACT = 'com.bugsee:bugsee-android-ndk';
const PROPERTIES_FILE = 'bugsee.properties';
const VERSION_RE = /^[0-9A-Za-z.+_-]+$/;
const IMPORT_RE = /^\s*import\s/;

/** A file shape we refuse to edit blindly; becomes a manual snippet. */
class CannotEdit extends Error {}

// ---------------------------------------------------------------------------
// Scanner: comments and strings blanked (same length, newlines kept) so braces and keywords
// are only ever read from code.
// ---------------------------------------------------------------------------

interface Scan {
  /** Source lines as written (a CRLF file keeps its `\r`). */
  readonly raw: string[];
  /** Comments and strings blanked. */
  readonly code: string[];
  /** Comments blanked, strings kept (for "does the file mention X"). */
  readonly text: string[];
  /** Brace depth at the start of line i; `depth[n]` is the depth after the last line. */
  readonly depth: number[];
  readonly cr: string;
}

function skipBraces(source: string, from: number): number {
  let depth = 0;
  for (let j = from; j < source.length; j += 1) {
    if (source[j] === '{') depth += 1;
    else if (source[j] === '}') {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return source.length;
}

function endOfString(source: string, start: number): number {
  const quote = source[start];
  let j = start + 1;
  while (j < source.length) {
    const c = source[j];
    if (c === '\\') j += 2;
    else if (c === '\n') return j;
    else if (quote === '"' && c === '$' && source[j + 1] === '{') j = skipBraces(source, j + 1);
    else if (c === quote) return j + 1;
    else j += 1;
  }
  return source.length;
}

function scan(source: string): Scan {
  const n = source.length;
  const code = source.split('');
  const text = source.split('');
  const blank = (arr: string[], from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (arr[k] !== '\n' && arr[k] !== '\r') arr[k] = ' ';
    }
  };
  let i = 0;
  while (i < n) {
    const two = source.slice(i, i + 2);
    const three = source.slice(i, i + 3);
    if (two === '//') {
      let e = source.indexOf('\n', i);
      if (e < 0) e = n;
      blank(code, i, e);
      blank(text, i, e);
      i = e;
    } else if (two === '/*') {
      const found = source.indexOf('*/', i + 2);
      const e = found < 0 ? n : found + 2;
      blank(code, i, e);
      blank(text, i, e);
      i = e;
    } else if (three === "'''" || three === '"""') {
      const found = source.indexOf(three, i + 3);
      const e = found < 0 ? n : found + 3;
      blank(code, i, e);
      i = e;
    } else if (source[i] === "'" || source[i] === '"') {
      const e = endOfString(source, i);
      blank(code, i, e);
      i = e;
    } else {
      i += 1;
    }
  }
  const raw = source.split('\n');
  const codeLines = code.join('').split('\n');
  const textLines = text.join('').split('\n');
  const depth: number[] = [];
  let d = 0;
  for (const line of codeLines) {
    depth.push(d);
    for (const ch of line) {
      if (ch === '{') d += 1;
      else if (ch === '}') d -= 1;
    }
  }
  depth.push(d);
  return {
    raw,
    code: codeLines,
    text: textLines,
    depth,
    cr: source.includes('\r\n') ? '\r' : '',
  };
}

const live = (s: Scan, re: RegExp): boolean => s.text.some((line) => re.test(line));

const indentOf = (line: string): string => line.slice(0, line.length - line.trimStart().length);

interface Block {
  readonly open: number;
  /** Closing line; equals `open` for a one-line block. */
  readonly close: number;
  readonly oneLine: boolean;
}

/**
 * The `name { ... }` block opening on a line at `atDepth` within [from, to). Null when absent.
 * A block whose braces do not stand on their own lines (other than the one-line `name { x }`)
 * cannot be edited with certainty.
 */
function findBlock(s: Scan, name: string, from: number, to: number, atDepth: number): Block | null {
  const opener = new RegExp(`^\\s*${name}\\s*\\{`);
  const clean = new RegExp(`^\\s*${name}\\s*\\{\\s*$`);
  const closesOnLine = /\}\s*$/;
  for (let i = from; i < to; i += 1) {
    const code = s.code[i] as string;
    if (s.depth[i] !== atDepth || !opener.test(code)) continue;
    if (closesOnLine.test(code) && s.depth[i + 1] === atDepth)
      return { open: i, close: i, oneLine: true };
    if (!clean.test(code)) throw new CannotEdit(`\`${name} {\` shares its line with other code`);
    for (let j = i + 1; j < to; j += 1) {
      if (s.depth[j + 1] === atDepth) {
        if ((s.code[j] as string).trim() !== '}') {
          throw new CannotEdit(`the closing brace of \`${name} {\` shares its line`);
        }
        return { open: i, close: j, oneLine: false };
      }
    }
    throw new CannotEdit(`\`${name} {\` is not closed`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Editing primitives
// ---------------------------------------------------------------------------

interface Op {
  readonly at: number;
  /** Lines removed at `at` before inserting. */
  readonly del: number;
  readonly lines: readonly string[];
}

function applyOps(s: Scan, ops: readonly Op[]): string {
  const out = [...s.raw];
  const sorted = [...ops].sort((a, b) => b.at - a.at);
  for (const op of sorted) {
    // Appending after an unterminated last line: the new last line stays unterminated too.
    const tail = op.at >= out.length ? op.lines.length - 1 : -1;
    out.splice(op.at, op.del, ...op.lines.map((l, i) => (i === tail ? l : `${l}${s.cr}`)));
  }
  return out.join('\n');
}

const block = (comment: string, body: readonly string[]): string[] => [
  `${comment} ${BEGIN}`,
  ...body,
  `${comment} ${END}`,
];

/** After a leading run of `import` lines (a `.kts` file needs them first), else the top. */
function afterImports(s: Scan): number {
  let at = 0;
  for (let i = 0; i < s.code.length; i += 1) {
    if (s.depth[i] === 0 && IMPORT_RE.test(s.code[i] as string)) at = i + 1;
  }
  return at;
}

/** Appends lines at the end of a file, keeping an unterminated last line unterminated. */
function appendLines(source: string, add: readonly string[]): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  if (source === '') return `${add.join(eol)}${eol}`;
  if (source.endsWith('\n')) return `${source}${add.join(eol)}${eol}`;
  return `${source}${eol}${add.join(eol)}`;
}

/** Inserts lines at the end of a file; an existing final newline stays last. */
function appendOp(s: Scan, add: readonly string[]): Op {
  const last = s.raw.length - 1;
  return s.raw[last] === ''
    ? { at: last, del: 0, lines: add }
    : { at: last + 1, del: 0, lines: add };
}

/** `// <ORIG>:N <original>` above N replacement lines: the rollback puts the original back. */
function replaceLine(raw: string, comment: string, replacement: readonly string[]): string[] {
  const original = raw.replace(/\r$/, '');
  return [
    `${indentOf(original)}${comment} ${ORIG}:${replacement.length} ${original.trimStart()}`,
    ...replacement,
  ];
}

const ORIG_LINE = new RegExp(
  `^([ \\t]*)(?:\\/\\/|#) ${ORIG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+) (.*)$`,
);
const LINE_MARKED = new RegExp(`^.*\\/\\/ ${LINE}[ \\t]*\\r?$`);
const BLOCK_RE = new RegExp(
  `[ \\t]*(?:\\/\\/|#) ${BEGIN}[\\s\\S]*?(?:\\/\\/|#) ${END}[ \\t]*(\\r?\\n|$)`,
  'g',
);

/** Removes everything this module added, restoring the user's own lines. */
export function stripOwn(source: string): string {
  // 1. Rewritten lines: orig comment + N replacement lines -> the original.
  const lines = source.split('\n');
  const restored: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const cr = line.endsWith('\r') ? '\r' : '';
    const m = ORIG_LINE.exec(line.replace(/\r$/, ''));
    if (m) {
      restored.push(`${m[1]}${m[3]}${cr}`);
      i += Number(m[2]);
    } else if (LINE_MARKED.test(line)) {
      // 2. Single added lines.
    } else {
      restored.push(line);
    }
  }
  // 3. Whole blocks; a block at the end of an unterminated file also takes the newline before it.
  const joined = restored.join('\n');
  let out = '';
  let last = 0;
  for (const m of joined.matchAll(BLOCK_RE)) {
    const start = m.index as number;
    out += joined.slice(last, start);
    if (m[1] === '') out = out.replace(/\r?\n$/, '');
    last = start + m[0].length;
  }
  return out + joined.slice(last);
}

// ---------------------------------------------------------------------------
// settings.gradle(.kts)
// ---------------------------------------------------------------------------

const REPOSITORIES = [
  'repositories {',
  '    gradlePluginPortal()',
  '    google()',
  '    mavenCentral()',
  '}',
];
const MAVEN_CENTRAL = /(?<![\w.])mavenCentral\s*\(/;

function settingsTransform(source: string): string {
  const s = scan(source);
  const pm = findBlock(s, 'pluginManagement', 0, s.raw.length, 0);
  if (!pm) {
    const body = ['pluginManagement {', ...REPOSITORIES.map((l) => `    ${l}`), '}'];
    return applyOps(s, [{ at: afterImports(s), del: 0, lines: block('//', body) }]);
  }
  if (pm.oneLine) {
    const code = s.code[pm.open] as string;
    if (MAVEN_CENTRAL.test(code)) return source;
    if (/\brepositories\b/.test(code)) {
      throw new CannotEdit('pluginManagement has an inline repositories block');
    }
    const raw = (s.raw[pm.open] as string).replace(/\r$/, '');
    const body = raw.slice(code.indexOf('{') + 1, code.lastIndexOf('}')).trim();
    const indent = indentOf(raw);
    const lines = [
      `${indent}pluginManagement {`,
      ...(body ? [`${indent}    ${body}`] : []),
      ...REPOSITORIES.map((l) => `${indent}    ${l}`),
      `${indent}}`,
    ];
    return applyOps(s, [
      { at: pm.open, del: 1, lines: replaceLine(s.raw[pm.open] as string, '//', lines) },
    ]);
  }
  const inner = s.code.slice(pm.open + 1, pm.close);
  if (inner.some((l) => MAVEN_CENTRAL.test(l))) return source;
  const repos = findBlock(s, 'repositories', pm.open + 1, pm.close, 1);
  if (repos?.oneLine) throw new CannotEdit('pluginManagement.repositories is an inline block');
  if (repos) {
    const indent = `${indentOf(s.raw[repos.close] as string)}    `;
    return applyOps(s, [
      { at: repos.close, del: 0, lines: [`${indent}mavenCentral() // ${LINE}`] },
    ]);
  }
  const indent = `${indentOf(s.raw[pm.close] as string)}    `;
  const body = REPOSITORIES.map((l) => `${indent}${l}`);
  return applyOps(s, [{ at: pm.close, del: 0, lines: block(`${indent}//`, body) }]);
}

// ---------------------------------------------------------------------------
// build.gradle(.kts) (root)
// ---------------------------------------------------------------------------

function rootTransform(source: string, kts: boolean, version: string): string {
  const s = scan(source);
  if (live(s, /com\.bugsee\.android\.gradle/)) return source;
  const pin = kts
    ? `id("${PLUGIN_ID}") version "${version}" apply false`
    : `id '${PLUGIN_ID}' version '${version}' apply false`;
  const plugins = findBlock(s, 'plugins', 0, s.raw.length, 0);
  if (plugins?.oneLine) throw new CannotEdit('the plugins block is on one line');
  if (plugins) {
    const indent = `${indentOf(s.raw[plugins.close] as string)}    `;
    return applyOps(s, [{ at: plugins.close, del: 0, lines: [`${indent}${pin} // ${LINE}`] }]);
  }
  // plugins {} has to stay right after buildscript {}.
  const buildscript = findBlock(s, 'buildscript', 0, s.raw.length, 0);
  const at = buildscript ? buildscript.close + 1 : afterImports(s);
  return applyOps(s, [{ at, del: 0, lines: block('//', ['plugins {', `    ${pin}`, '}']) }]);
}

// ---------------------------------------------------------------------------
// app/build.gradle(.kts)
// ---------------------------------------------------------------------------

const BUGSEE_DIR_GROOVY = [
  `def bugseeDir = new File(["node", "--print", "require.resolve('@bugsee/react-native/package.json')"]`,
  '    .execute(null, rootDir).text.trim()).getParentFile()',
];
const BUGSEE_DIR_KOTLIN = [
  'val bugseeDir = File(',
  `    ProcessBuilder("node", "--print", "require.resolve('@bugsee/react-native/package.json')")`,
  '        .directory(rootDir).start().inputStream.bufferedReader().readText().trim()',
  ').parentFile',
];
const HERMES_EXPR_GROOVY =
  'new File(new File(bugseeDir, "scripts"), System.getProperty("os.name").startsWith("Windows") ? "hermesc-preserve-js.cmd" : "hermesc-preserve-js.sh").absolutePath';
const HERMES_EXPR_KOTLIN =
  'File(File(bugseeDir, "scripts"), if (System.getProperty("os.name").startsWith("Windows")) "hermesc-preserve-js.cmd" else "hermesc-preserve-js.sh").absolutePath';
const APPLY_FROM_GROOVY =
  'apply from: new File(new File(bugseeDir, "scripts"), "bugsee-sourcemaps.gradle")';
const APPLY_FROM_KOTLIN =
  'apply(from = File(File(bugseeDir, "scripts"), "bugsee-sourcemaps.gradle"))';

const REACT_APPLY = /^\s*apply\s+plugin:\s*["']com\.facebook\.react["']\s*$/;
const HERMES_COMMAND = /^([ \t]*)hermesCommand(\s*=(?!=)|\.set\()/;
const CONTINUATION = /^(\?\.|\.|\?|:|\+|-|\*|\/|&&|\|\|)/;

function completeExpression(value: string): boolean {
  let depth = 0;
  for (const ch of value) {
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
  }
  return depth === 0 && value.trim().length > 0 && !/[-+*/,([.?:&|=]$/.test(value.trimEnd());
}

function appTransform(source: string, kts: boolean, sdk: string): string {
  const s = scan(source);
  const ops: Op[] = [];
  const hermesLine = (expr: string): string =>
    kts ? `hermesCommand.set(${expr})` : `hermesCommand = ${expr}`;
  const hermesExpr = kts ? HERMES_EXPR_KOTLIN : HERMES_EXPR_GROOVY;

  // --- plugin apply -----------------------------------------------------
  let anchorEnd = -1; // line index after which `bugseeDir` may go
  let pluginOp: Op | null = null;
  if (live(s, /com\.bugsee\.android\.gradle/)) {
    anchorEnd = s.text.findIndex((l) => /com\.bugsee\.android\.gradle/.test(l)) + 1;
  } else {
    const react = s.code.findIndex(
      (l, i) => s.depth[i] === 0 && REACT_APPLY.test(s.text[i] as string),
    );
    const plugins = findBlock(s, 'plugins', 0, s.raw.length, 0);
    if (!kts && react >= 0) {
      const indent = indentOf(s.raw[react] as string);
      pluginOp = {
        at: react + 1,
        del: 0,
        lines: [`${indent}apply plugin: "${PLUGIN_ID}" // ${LINE}`],
      };
      anchorEnd = react + 1;
    } else if (plugins && !plugins.oneLine) {
      const indent = `${indentOf(s.raw[plugins.close] as string)}    `;
      const entry = kts ? `id("${PLUGIN_ID}")` : `id '${PLUGIN_ID}'`;
      pluginOp = { at: plugins.close, del: 0, lines: [`${indent}${entry} // ${LINE}`] };
      anchorEnd = plugins.close + 1;
    } else {
      throw new CannotEdit(
        kts
          ? 'no plugins { } block to add the Bugsee plugin to'
          : 'neither `apply plugin: "com.facebook.react"` nor a plugins { } block to anchor on',
      );
    }
  }

  // --- react { hermesCommand } -----------------------------------------
  const reactBlock = findBlock(s, 'react', 0, s.raw.length, 0);
  if (reactBlock?.oneLine) throw new CannotEdit('the react block is on one line');
  let needReactBlock = false;
  if (reactBlock) {
    let found = false;
    for (let i = reactBlock.open + 1; i < reactBlock.close; i += 1) {
      const code = s.code[i] as string;
      const match = s.depth[i] === 1 ? HERMES_COMMAND.exec(code) : null;
      if (!match) continue;
      found = true;
      const text = s.text[i] as string;
      if (text.includes('hermesc-preserve-js')) continue;
      const raw = s.raw[i] as string;
      let commentAt = raw.length;
      for (let k = 0; k < raw.length; k += 1) {
        if (raw[k] !== text[k]) {
          commentAt = k;
          break;
        }
      }
      const valueEnd = raw.slice(0, commentAt).trimEnd().length;
      // Strings are blanked in `code`; stand in a letter for their characters so a plain
      // string value is not mistaken for "nothing after the `=`".
      const shown = [...code].map((ch, k) => (ch === ' ' && text[k] !== ' ' ? 'x' : ch)).join('');
      const value = `${match[2] === '.set(' ? '(' : ''}${shown.slice(match[0].length)}`;
      const next = s.code.slice(i + 1).find((l) => l.trim().length > 0) ?? '';
      if (value.includes(';') || !completeExpression(value) || CONTINUATION.test(next.trim())) {
        throw new CannotEdit('react.hermesCommand spans several lines or shares its line');
      }
      const replacement = `${match[1]}${hermesLine(hermesExpr)}${raw.slice(valueEnd).replace(/\r$/, '')}`;
      ops.push({ at: i, del: 1, lines: replaceLine(raw, '//', [replacement]) });
    }
    if (!found) {
      const indent = `${indentOf(s.raw[reactBlock.open] as string)}    `;
      ops.push({
        at: reactBlock.open + 1,
        del: 0,
        lines: [`${indent}${hermesLine(hermesExpr)} // ${LINE}`],
      });
    }
  } else {
    needReactBlock = true;
  }

  // --- bugseeDir (+ a react block when the file has none) ---------------
  const head: string[] = [];
  if (!live(s, /\bbugseeDir\b/)) {
    head.push(...block('//', kts ? BUGSEE_DIR_KOTLIN : BUGSEE_DIR_GROOVY));
  }
  if (needReactBlock) {
    head.push(...block('//', ['react {', `    ${hermesLine(hermesExpr)}`, '}']));
  }
  // `bugseeDir` must be defined before the react block that uses it.
  const headAt = reactBlock ? Math.min(anchorEnd, reactBlock.open) : anchorEnd;
  if (pluginOp && head.length > 0 && pluginOp.at === headAt) {
    ops.push({ at: headAt, del: 0, lines: [...pluginOp.lines, ...head] });
    pluginOp = null;
  } else if (head.length > 0) {
    ops.push({ at: headAt, del: 0, lines: head });
  }
  if (pluginOp) ops.push(pluginOp);

  // --- NDK dependency + sourcemaps hook, at the end ---------------------
  const tail: string[] = [];
  if (!live(s, /bugsee-android-ndk/)) {
    if (kts) {
      tail.push('dependencies {', `    implementation("${NDK_ARTIFACT}:${sdk}")`, '}');
    } else {
      tail.push(
        'def bugseeVersions = new groovy.json.JsonSlurper().parse(new File(bugseeDir, "native-versions.json"))',
        '',
        'dependencies {',
        `    implementation "${NDK_ARTIFACT}:\${bugseeVersions.android.sdk}"`,
        '}',
      );
    }
  }
  if (!live(s, /bugsee-sourcemaps\.gradle/)) {
    tail.push(kts ? APPLY_FROM_KOTLIN : APPLY_FROM_GROOVY);
  }
  if (tail.length > 0) ops.push(appendOp(s, block('//', tail)));

  return ops.length === 0 ? source : applyOps(s, ops);
}

// ---------------------------------------------------------------------------
// Manual snippets (README text; never carry the token)
// ---------------------------------------------------------------------------

function settingsManual(): string {
  return [
    'pluginManagement {',
    '    // keep your existing lines (includeBuild ...) and make sure Maven Central is searched:',
    '    repositories {',
    '        gradlePluginPortal()',
    '        google()',
    '        mavenCentral()',
    '    }',
    '}',
  ].join('\n');
}

function rootManual(kts: boolean, version: string): string {
  const pin = kts
    ? `id("${PLUGIN_ID}") version "${version}" apply false`
    : `id '${PLUGIN_ID}' version '${version}' apply false`;
  return `// above the react rootproject apply, after buildscript { }\nplugins {\n    ${pin}\n}`;
}

function appManual(kts: boolean, sdk: string): string {
  if (kts) {
    return [
      'plugins {',
      `    id("${PLUGIN_ID}")`,
      '}',
      '',
      ...BUGSEE_DIR_KOTLIN,
      '',
      'react {',
      `    hermesCommand.set(${HERMES_EXPR_KOTLIN})`,
      '}',
      '',
      'dependencies {',
      `    implementation("${NDK_ARTIFACT}:${sdk}")`,
      '}',
      '',
      '// At the end of the file.',
      APPLY_FROM_KOTLIN,
    ].join('\n');
  }
  return [
    `apply plugin: "${PLUGIN_ID}"`,
    '',
    ...BUGSEE_DIR_GROOVY,
    '',
    'react {',
    `    hermesCommand = ${HERMES_EXPR_GROOVY}`,
    '}',
    '',
    'def bugseeVersions = new groovy.json.JsonSlurper().parse(new File(bugseeDir, "native-versions.json"))',
    'dependencies {',
    `    implementation "${NDK_ARTIFACT}:\${bugseeVersions.android.sdk}"`,
    '}',
    '',
    '// At the end of the file.',
    APPLY_FROM_GROOVY,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Step factories
// ---------------------------------------------------------------------------

function androidDir(ctx: RnContext): string | null {
  return ctx.rnPaths.androidPath;
}

function enabled(ctx: RnContext): boolean {
  return androidDir(ctx) !== null && (ctx.tokens.android ?? '').trim().length > 0;
}

const NOTHING = (ctx: RnContext): string =>
  androidDir(ctx) === null ? 'no android/ directory' : 'no Android app token';

async function locate(dir: string, rels: readonly string[]): Promise<string | null> {
  for (const rel of rels) {
    const abs = path.join(dir, rel);
    if ((await readOrNull(abs)) !== null) return abs;
  }
  return null;
}

function checkedVersion(label: string, value: string): string {
  if (!VERSION_RE.test(value)) throw new CannotEdit(`${label} "${value}" is not a plain version`);
  return value;
}

interface GradleFileSpec {
  readonly id: string;
  readonly title: string;
  readonly candidates: readonly string[];
  readonly transform: (source: string, kts: boolean, ctx: RnContext) => string;
  readonly manual: (kts: boolean, ctx: RnContext) => string;
}

function gradleFileStep(spec: GradleFileSpec): Step<RnContext> {
  const relOf = (ctx: RnContext, abs: string): string => path.relative(ctx.cwd, abs);
  const manualFor = (ctx: RnContext, file: string, kts: boolean): ManualSnippet => ({
    file: relOf(ctx, file),
    title: spec.title,
    code: spec.manual(kts, ctx),
  });
  return {
    id: spec.id,
    title: spec.title,

    async precheck(ctx): Promise<StepStatus> {
      if (!enabled(ctx)) return { kind: 'satisfied', note: NOTHING(ctx) };
      const file = await locate(androidDir(ctx) as string, spec.candidates);
      if (file === null) return { kind: 'pending' };
      const source = (await readOrNull(file)) as string;
      try {
        return spec.transform(source, file.endsWith('.kts'), ctx) === source
          ? { kind: 'satisfied' }
          : { kind: 'pending' };
      } catch (err) {
        if (err instanceof CannotEdit) return { kind: 'pending' };
        throw err;
      }
    },

    async apply(ctx): Promise<ApplyResult | undefined> {
      const dir = androidDir(ctx) as string;
      const file = await locate(dir, spec.candidates);
      if (file === null) {
        const expected = path.join(dir, spec.candidates[0] as string);
        return { manual: manualFor(ctx, expected, false) };
      }
      const kts = file.endsWith('.kts');
      const source = (await readOrNull(file)) as string;
      let updated: string;
      try {
        updated = spec.transform(source, kts, ctx);
      } catch (err) {
        if (err instanceof CannotEdit) return { manual: manualFor(ctx, file, kts) };
        throw err;
      }
      if (updated !== source) await writeFile(file, updated);
      return undefined;
    },

    async rollback(ctx): Promise<void> {
      const dir = androidDir(ctx);
      if (dir === null) return;
      const file = await locate(dir, spec.candidates);
      if (file === null) return;
      const source = (await readOrNull(file)) as string;
      const stripped = stripOwn(source);
      if (stripped !== source) await writeFile(file, stripped);
    },
  };
}

const settingsGradleStep = gradleFileStep({
  id: 'rn.android.settings-gradle',
  title: 'Search Maven Central for Gradle plugins (android/settings.gradle)',
  candidates: ['settings.gradle', 'settings.gradle.kts'],
  transform: (source) => settingsTransform(source),
  manual: () => settingsManual(),
});

const rootGradleStep = gradleFileStep({
  id: 'rn.android.root-gradle',
  title: 'Declare the Bugsee Gradle plugin (android/build.gradle)',
  candidates: ['build.gradle', 'build.gradle.kts'],
  transform: (source, kts, ctx) =>
    rootTransform(
      source,
      kts,
      checkedVersion('Gradle plugin version', ctx.rnOptions.nativeVersions.androidGradlePlugin),
    ),
  manual: (kts, ctx) => rootManual(kts, ctx.rnOptions.nativeVersions.androidGradlePlugin),
});

const appGradleStep = gradleFileStep({
  id: 'rn.android.app-gradle',
  title: 'Apply the Bugsee Gradle plugin and source-map hook (android/app/build.gradle)',
  candidates: ['app/build.gradle', 'app/build.gradle.kts'],
  transform: (source, kts, ctx) =>
    appTransform(
      source,
      kts,
      checkedVersion('Android SDK version', ctx.rnOptions.nativeVersions.androidSdk),
    ),
  manual: (kts, ctx) => appManual(kts, ctx.rnOptions.nativeVersions.androidSdk),
});

// ---------------------------------------------------------------------------
// .gitignore + bugsee.properties
// ---------------------------------------------------------------------------

const IGNORES_PROPERTIES = /^(?:\/?(?:android\/)?|\*\*\/)bugsee\.properties$/;

function ignoresProperties(content: string | null): boolean {
  return (
    content !== null && content.split(/\r?\n/).some((line) => IGNORES_PROPERTIES.test(line.trim()))
  );
}

async function removeIfBlank(file: string, stripped: string): Promise<void> {
  if (stripped.trim() === '') await rm(file, { force: true });
  else await writeFile(file, stripped);
}

const gitignoreStep: Step<RnContext> = {
  id: 'rn.android.gitignore',
  title: 'Git-ignore android/bugsee.properties',

  async precheck(ctx): Promise<StepStatus> {
    if (!enabled(ctx)) return { kind: 'satisfied', note: NOTHING(ctx) };
    const dir = androidDir(ctx) as string;
    const candidates = [path.join(dir, '.gitignore'), path.join(ctx.cwd, '.gitignore')];
    for (const file of candidates) {
      if (ignoresProperties(await readOrNull(file))) return { kind: 'satisfied' };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const file = path.join(androidDir(ctx) as string, '.gitignore');
    const existing = (await readOrNull(file)) ?? '';
    await writeFile(file, appendLines(existing, block('#', [PROPERTIES_FILE])));
  },

  async rollback(ctx) {
    const dir = androidDir(ctx);
    if (dir === null) return;
    const file = path.join(dir, '.gitignore');
    const existing = await readOrNull(file);
    if (existing === null) return;
    const stripped = stripOwn(existing);
    if (stripped !== existing) await removeIfBlank(file, stripped);
  },
};

const TOKEN_LINE = /^\s*app_token\s*[=:]\s*(.*?)\s*$/;
const NDK_LINE = /^\s*plugin\.ndk\.enabled\s*[=:]/;

function cleanToken(ctx: RnContext): string {
  const token = (ctx.tokens.android ?? '').trim();
  if (/[\r\n]/.test(token)) throw new Error('Android app token contains a line break');
  return token;
}

const propertiesStep: Step<RnContext> = {
  id: 'rn.android.bugsee-properties',
  title: 'Write the app token to android/bugsee.properties',

  async precheck(ctx): Promise<StepStatus> {
    if (!enabled(ctx)) return { kind: 'satisfied', note: NOTHING(ctx) };
    const content = await readOrNull(path.join(androidDir(ctx) as string, PROPERTIES_FILE));
    if (content === null) return { kind: 'pending' };
    const lines = content.split(/\r?\n/);
    const stored = lines.map((l) => TOKEN_LINE.exec(l)).find((m) => m !== null);
    const hasNdk = lines.some((l) => NDK_LINE.test(l));
    return stored && stored[1] === cleanToken(ctx) && hasNdk
      ? { kind: 'satisfied' }
      : { kind: 'pending' };
  },

  async apply(ctx) {
    const token = cleanToken(ctx);
    const file = path.join(androidDir(ctx) as string, PROPERTIES_FILE);
    const existing = (await readOrNull(file)) ?? '';
    const s = scan(existing);
    const ops: Op[] = [];
    const added: string[] = [];
    const tokenAt = s.raw.findIndex((l) => TOKEN_LINE.test(l.replace(/\r$/, '')));
    if (tokenAt < 0) {
      added.push(`app_token=${token}`);
    } else if (
      (TOKEN_LINE.exec((s.raw[tokenAt] as string).replace(/\r$/, ''))?.[1] ?? '') !== token
    ) {
      ops.push({
        at: tokenAt,
        del: 1,
        lines: replaceLine(s.raw[tokenAt] as string, '#', [`app_token=${token}`]),
      });
    }
    if (!s.raw.some((l) => NDK_LINE.test(l))) added.push('plugin.ndk.enabled=true');
    if (added.length > 0) ops.push(appendOp(s, block('#', added)));
    await mkdir(path.dirname(file), { recursive: true });
    if (existing === '') {
      await writeFile(file, appendLines('', block('#', added)));
      return;
    }
    await writeFile(file, applyOps(s, ops));
  },

  async rollback(ctx) {
    const dir = androidDir(ctx);
    if (dir === null) return;
    const file = path.join(dir, PROPERTIES_FILE);
    const existing = await readOrNull(file);
    if (existing === null) return;
    const stripped = stripOwn(existing);
    if (stripped !== existing) await removeIfBlank(file, stripped);
  },
};

export const androidGradleSteps: Step<RnContext>[] = [
  settingsGradleStep,
  rootGradleStep,
  appGradleStep,
  gitignoreStep,
  propertiesStep,
];

import { parseModule } from 'magicast';
import {
  child,
  children,
  collectBoundNames,
  hasBugseeMarker,
  isNode,
  isRequireDeclaration,
  lineEndIfCommentTail,
  type Node,
  name,
  parses,
} from './config-ast.js';
import { isRuntimeSdkPackage } from './sdk-packages.js';

/**
 * Static (never executed) edit of a project's entry file: add the Bugsee SDK import and a
 * `launch(<token>)` call. Same contract as the bundler-plugin edit: the text outside the two inserted
 * lines is left byte-for-byte alone, the result must re-parse, and any shape that is not understood
 * ends in a `{ manual }` snippet rather than a guess.
 */

export type SdkRuntime = 'browser' | 'node' | 'bun';

export interface SdkInitSpec {
  /** The package `launch` is imported from (`@bugsee/bugsee`, `@bugsee/bun`, ...). */
  importFrom: string;
  /** An expression that yields the token at run time (`process.env.X`); absent: `token` is written as a literal. */
  tokenExpr?: string;
  /** Written as a string literal when there is no `tokenExpr`. Never appears in a manual snippet. */
  token: string;
  /** The entry file's name: its extension decides TypeScript and (with the content) the module system. */
  fileName: string;
  /** `type` of the owning package.json, when set. */
  packageType?: string;
  runtime: SdkRuntime;
  /** Whether the project already types `import.meta.env` (Vite's client types); only matters for TS. */
  viteClientTypes?: boolean;
}

export type SdkInitResult = { code: string } | { manual: string };

const MARKER = 'bugsee-wizard';
const PLACEHOLDER = '<your Bugsee app token>';
const LAUNCH = 'launch';
const LAUNCH_ALIAS = 'bugseeLaunch';
const VITE_REFERENCE = '/// <reference types="vite/client" />';

const DECLARES_NAME = new Set([
  'FunctionDeclaration',
  'ClassDeclaration',
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration',
  'TSEnumDeclaration',
]);

const isTs = (fileName: string): boolean => /\.[cm]?tsx?$/i.test(fileName);

function isSdkPackage(spec: string | undefined): boolean {
  return isRuntimeSdkPackage(spec);
}

function requireArg(call: Node | undefined): string | undefined {
  if (call?.type !== 'CallExpression' || name(child(call, 'callee')) !== 'require')
    return undefined;
  return name(children(call, 'arguments')[0] ?? undefined);
}

function programOf(source: string): { body: Node[]; directives: Node[] } | undefined {
  try {
    const program = parseModule(source).$ast as unknown;
    if (!isNode(program)) return undefined;
    return {
      body: children(program, 'body').filter((n): n is Node => n !== null),
      directives: children(program, 'directives').filter((n): n is Node => n !== null),
    };
  } catch {
    return undefined;
  }
}

const SKIP_KEYS = new Set([
  'loc',
  'original',
  'tokens',
  'comments',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'extra',
]);

/** The module specifier a node loads at run time (static import, require, dynamic import), if any. */
function loadedModule(node: Node): string | undefined {
  if (node.type === 'ImportDeclaration') {
    // `import type` is erased: it does not run the SDK
    return node.importKind === 'type' || node.importKind === 'typeof'
      ? undefined
      : name(child(node, 'source'));
  }
  if (node.type === 'ImportExpression') return name(child(node, 'source'));
  if (node.type !== 'CallExpression') return undefined;
  const callee = child(node, 'callee');
  if (name(callee) === 'require' || callee?.type === 'Import') {
    return name(children(node, 'arguments')[0] ?? undefined);
  }
  return undefined;
}

/** Whether any node under `root` (nested and dynamic loads included) loads a runtime SDK package. */
function loadsSdk(root: unknown, seen = new Set<unknown>()): boolean {
  if (typeof root !== 'object' || root === null || seen.has(root)) return false;
  seen.add(root);
  if (Array.isArray(root)) return root.some((x) => loadsSdk(x, seen));
  if (isNode(root) && isSdkPackage(loadedModule(root))) return true;
  return Object.entries(root).some(([k, v]) => !SKIP_KEYS.has(k) && loadsSdk(v, seen));
}

/** True when the wizard's marker comment is in the file, or a Bugsee runtime package is already loaded. */
export function hasSdkIntegration(source: string): boolean {
  if (hasBugseeMarker(source)) return true;
  try {
    return loadsSdk(parseModule(source).$ast);
  } catch {
    return false;
  }
}

function boundNames(body: Node[]): Set<string> {
  const out: string[] = [];
  for (const raw of body) {
    const stmt =
      raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportDefaultDeclaration'
        ? (child(raw, 'declaration') ?? raw)
        : raw;
    if (stmt.type === 'ImportDeclaration') {
      for (const sp of children(stmt, 'specifiers')) {
        const local = name(sp ? child(sp, 'local') : undefined);
        if (local !== undefined) out.push(local);
      }
    } else if (stmt.type === 'VariableDeclaration') {
      for (const d of children(stmt, 'declarations'))
        collectBoundNames(d ? child(d, 'id') : undefined, out);
    } else if (DECLARES_NAME.has(stmt.type)) {
      const id = name(child(stmt, 'id'));
      if (id !== undefined) out.push(id);
    }
  }
  return new Set(out);
}

function hasEsmSyntax(body: Node[]): boolean {
  return body.some((s) => s.type === 'ImportDeclaration' || s.type.startsWith('Export'));
}

/** `module.exports`, `exports`, or a member of either: the only assignments that mean CommonJS. */
function exportsTarget(node: Node | undefined): boolean {
  let cur = node;
  while (cur?.type === 'MemberExpression') {
    const obj = child(cur, 'object');
    if (name(obj) === 'module' && name(child(cur, 'property')) === 'exports') return true;
    cur = obj;
  }
  return cur?.type === 'Identifier' && name(cur) === 'exports';
}

function hasCjsSyntax(body: Node[]): boolean {
  return body.some((s) => {
    if (isRequireDeclaration(s)) return true;
    const e = s.type === 'ExpressionStatement' ? child(s, 'expression') : undefined;
    return (
      (e?.type === 'AssignmentExpression' && exportsTarget(child(e, 'left'))) ||
      requireArg(e) !== undefined
    );
  });
}

/** CommonJS or ESM syntax for the new lines. Browser entries and TypeScript (except .cts) are always ESM. */
function isCommonJs(spec: SdkInitSpec, body: Node[]): boolean {
  const file = spec.fileName.toLowerCase();
  if (file.endsWith('.cjs') || file.endsWith('.cts')) return true;
  if (file.endsWith('.mjs') || file.endsWith('.mts') || isTs(file)) return false;
  if (hasEsmSyntax(body)) return false;
  if (hasCjsSyntax(body)) return true;
  // no syntax to go on: a bundled page entry is ESM, a server follows its package type
  return spec.runtime !== 'browser' && spec.packageType !== 'module';
}

function literal(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  return `'${escaped}'`;
}

/**
 * `process.env.X` as `process.env['X']`: dotted access to an index signature is an error under
 * `noPropertyAccessFromIndexSignature` (part of strictest configs), bracket access is valid under all.
 */
export function memberAccess(expr: string): string {
  const dot = expr.lastIndexOf('.');
  return dot === -1 ? expr : `${expr.slice(0, dot)}['${expr.slice(dot + 1)}']`;
}

function tokenArg(spec: SdkInitSpec, token: string | undefined): string {
  return spec.tokenExpr === undefined
    ? literal(token ?? PLACEHOLDER)
    : memberAccess(spec.tokenExpr);
}

/**
 * The import and the call. A token that comes from the environment is guarded: a missing variable
 * (production, CI, a container without .env) must leave the app running without Bugsee, because
 * `launch(undefined)` throws.
 */
function lines(
  spec: SdkInitSpec,
  cjs: boolean,
  fn: string,
  token: string | undefined,
): [string, string] {
  const imp = cjs
    ? `const { ${fn === LAUNCH ? LAUNCH : `${LAUNCH}: ${fn}`} } = require('${spec.importFrom}'); // ${MARKER}`
    : `import { ${fn === LAUNCH ? LAUNCH : `${LAUNCH} as ${fn}`} } from '${spec.importFrom}'; // ${MARKER}`;
  const arg = tokenArg(spec, token);
  // in a page launch() returns a promise: handled, so no lint rule or unhandled rejection objects
  const run = `${fn}(${arg})${spec.runtime === 'browser' ? '.catch(() => {})' : ''}`;
  const call =
    spec.tokenExpr === undefined ? `${run}; // ${MARKER}` : `if (${arg}) ${run}; // ${MARKER}`;
  return [imp, call];
}

/** The two lines as the user would type them by hand: a placeholder, never the real token. */
export function sdkInitSnippet(spec: SdkInitSpec, cjs: boolean): string {
  return lines(spec, cjs, LAUNCH, undefined).join('\n');
}

/** Local names bound to the `dotenv` package at the top level (ESM imports and CommonJS requires). */
function dotenvNames(body: Node[]): Set<string> {
  const out: string[] = [];
  for (const stmt of body) {
    if (stmt.type === 'ImportDeclaration' && name(child(stmt, 'source')) === 'dotenv') {
      for (const sp of children(stmt, 'specifiers')) {
        const local = name(sp ? child(sp, 'local') : undefined);
        if (local !== undefined) out.push(local);
      }
    } else if (stmt.type === 'VariableDeclaration') {
      for (const d of children(stmt, 'declarations')) {
        if (d && requireArg(child(d, 'init')) === 'dotenv') collectBoundNames(child(d, 'id'), out);
      }
    }
  }
  return new Set(out);
}

/** The last top-level statement that loads an env file (`dotenv.config()`, `config()`, `process.loadEnvFile()`). */
function lastEnvLoad(body: Node[]): Node | undefined {
  const names = dotenvNames(body);
  const loads = (call: Node | undefined): boolean => {
    if (call?.type !== 'CallExpression') return false;
    const callee = child(call, 'callee');
    if (callee?.type === 'Identifier') return names.has(name(callee) ?? '');
    if (callee?.type !== 'MemberExpression') return false;
    const obj = child(callee, 'object');
    const prop = name(child(callee, 'property'));
    if (name(obj) === 'process') return prop === 'loadEnvFile';
    return names.has(name(obj) ?? '') || requireArg(obj) === 'dotenv';
  };
  const found = body.filter((s) => {
    if (s.type !== 'ExpressionStatement') return false;
    const e = child(s, 'expression');
    if (requireArg(e) === 'dotenv/config') return true;
    return loads(e?.type === 'AwaitExpression' ? child(e, 'argument') : e);
  });
  return found[found.length - 1];
}

/** Whether the file itself loads an env file (`import 'dotenv/config'`, `dotenv.config()`, `process.loadEnvFile()`). */
export function loadsEnvFile(source: string): boolean {
  const program = programOf(source);
  if (!program) return false;
  const sideEffect = program.body.some((s) => {
    if (s.type === 'ImportDeclaration') return name(child(s, 'source')) === 'dotenv/config';
    return (
      requireArg(s.type === 'ExpressionStatement' ? child(s, 'expression') : undefined) ===
      'dotenv/config'
    );
  });
  return sideEffect || lastEnvLoad(program.body) !== undefined;
}

function lineStart(source: string, pos: number): number {
  return source.lastIndexOf('\n', pos - 1) + 1;
}

/**
 * Add the SDK import and `launch(...)` to an entry file's source. Idempotent (a marker, or a Bugsee
 * runtime package already imported, leaves the source as is); unsupported shapes -> `{ manual }`.
 */
export function addSdkInit(original: string, spec: SdkInitSpec): SdkInitResult {
  if (hasSdkIntegration(original)) return { code: original };
  // recast positions are against LF-normalised text: edit that and restore CRLF after
  const crlf = original.includes('\r\n');
  let source = crlf ? original.replace(/\r\n/g, '\n') : original;
  const bom = source.startsWith('﻿') ? '﻿' : '';
  source = source.slice(bom.length);
  let shebang = '';
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n');
    shebang = nl === -1 ? source : source.slice(0, nl + 1);
    source = source.slice(shebang.length);
  }

  const program = programOf(source);
  const manualFor = (cjs: boolean): SdkInitResult => ({ manual: sdkInitSnippet(spec, cjs) });
  if (!program) return manualFor(spec.runtime !== 'browser' && !isTs(spec.fileName));
  const { body, directives } = program;
  const cjs = isCommonJs(spec, body);

  const taken = boundNames(body);
  const fn = !taken.has(LAUNCH) ? LAUNCH : !taken.has(LAUNCH_ALIAS) ? LAUNCH_ALIAS : undefined;
  if (fn === undefined) return manualFor(cjs);
  const [importLine, callLine] = lines(spec, cjs, fn, spec.token);

  const anchors = cjs
    ? body.filter(isRequireDeclaration)
    : body.filter((s) => s.type === 'ImportDeclaration');
  let anchor = anchors[anchors.length - 1] ?? directives[directives.length - 1];
  // a token read from process.env must be read after the env file is loaded
  if (spec.tokenExpr?.startsWith('process.env.') === true) {
    const load = lastEnvLoad(body);
    if (load !== undefined && (anchor === undefined || load.end > anchor.end)) anchor = load;
  }
  let code: string;
  if (anchor) {
    const at = lineEndIfCommentTail(source, anchor.end);
    // code that follows the statement on its own line moves below the new lines (never into a comment)
    const nl = source.indexOf('\n', at);
    const rest = source.slice(at, nl === -1 ? source.length : nl);
    const gap = rest.trim() === '' ? '' : '\n';
    code = `${source.slice(0, at)}\n${importLine}\n${callLine}${gap}${source.slice(at)}`;
  } else if (body[0]) {
    const at = lineStart(source, body[0].start);
    code = `${source.slice(0, at)}${importLine}\n${callLine}\n${source.slice(at)}`;
  } else {
    const sep = source === '' || source.endsWith('\n') ? '' : '\n';
    code = `${source}${sep}${importLine}\n${callLine}\n`;
  }

  // TypeScript only knows `import.meta.env` through Vite's client types: reference them when absent
  if (
    isTs(spec.fileName) &&
    spec.tokenExpr?.startsWith('import.meta.env.') === true &&
    spec.viteClientTypes !== true &&
    !/types\s*=\s*["']vite\/client["']/.test(source)
  ) {
    code = `${VITE_REFERENCE}\n${code}`;
  }

  if (!parses(code)) return manualFor(cjs);
  code = bom + shebang + code;
  return { code: crlf ? code.replace(/\n/g, '\r\n') : code };
}

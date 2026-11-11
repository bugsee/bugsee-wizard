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
/** @bugsee packages that are build tooling, not the runtime SDK. */
const TOOLING_RE = /^@bugsee\/(?:cli|bugsee-cli|[\w-]*plugin[\w-]*)$/;

const DECLARES_NAME = new Set([
  'FunctionDeclaration',
  'ClassDeclaration',
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration',
  'TSEnumDeclaration',
]);

const isTs = (fileName: string): boolean => /\.[cm]?tsx?$/i.test(fileName);

function isSdkPackage(spec: string | undefined): boolean {
  return spec !== undefined && spec.startsWith('@bugsee/') && !TOOLING_RE.test(spec);
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

function importsSdk(body: Node[]): boolean {
  return body.some((stmt) => {
    if (stmt.type === 'ImportDeclaration') return isSdkPackage(name(child(stmt, 'source')));
    if (stmt.type === 'ExpressionStatement') {
      return isSdkPackage(requireArg(child(stmt, 'expression')));
    }
    if (stmt.type !== 'VariableDeclaration') return false;
    return children(stmt, 'declarations').some((d) =>
      isSdkPackage(requireArg(d ? child(d, 'init') : undefined)),
    );
  });
}

/** True when the wizard's marker comment is in the file, or a Bugsee runtime package is already imported. */
export function hasSdkIntegration(source: string): boolean {
  if (hasBugseeMarker(source)) return true;
  const program = programOf(source);
  return program !== undefined && importsSdk(program.body);
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
  if (spec.runtime === 'browser') return false;
  if (file.endsWith('.cjs') || file.endsWith('.cts')) return true;
  if (file.endsWith('.mjs') || file.endsWith('.mts') || isTs(file)) return false;
  if (hasEsmSyntax(body)) return false;
  if (hasCjsSyntax(body)) return true;
  return spec.packageType !== 'module';
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

function tokenArg(spec: SdkInitSpec, token: string | undefined): string {
  if (spec.tokenExpr === undefined) return literal(token ?? PLACEHOLDER);
  const cast = isTs(spec.fileName) && spec.tokenExpr.startsWith('process.env.') ? ' as string' : '';
  return `${spec.tokenExpr}${cast}`;
}

function lines(
  spec: SdkInitSpec,
  cjs: boolean,
  fn: string,
  token: string | undefined,
): [string, string] {
  const imp = cjs
    ? `const { ${fn === LAUNCH ? LAUNCH : `${LAUNCH}: ${fn}`} } = require('${spec.importFrom}'); // ${MARKER}`
    : `import { ${fn === LAUNCH ? LAUNCH : `${LAUNCH} as ${fn}`} } from '${spec.importFrom}'; // ${MARKER}`;
  return [imp, `${fn}(${tokenArg(spec, token)}); // ${MARKER}`];
}

/** The two lines as the user would type them by hand: a placeholder, never the real token. */
export function sdkInitSnippet(spec: SdkInitSpec, cjs: boolean): string {
  return lines(spec, cjs, LAUNCH, undefined).join('\n');
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
    const loads = body.filter((s) => /\bdotenv\b/.test(source.slice(s.start, s.end)));
    const last = loads[loads.length - 1];
    if (last !== undefined && (anchor === undefined || last.end > anchor.end)) anchor = last;
  }
  let code: string;
  if (anchor) {
    const at = lineEndIfCommentTail(source, anchor.end);
    code = `${source.slice(0, at)}\n${importLine}\n${callLine}${source.slice(at)}`;
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
    spec.viteClientTypes !== true
  ) {
    code = `${VITE_REFERENCE}\n${code}`;
  }

  if (!parses(code)) return manualFor(cjs);
  code = bom + shebang + code;
  return { code: crlf ? code.replace(/\n/g, '\r\n') : code };
}

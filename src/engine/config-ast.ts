import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree } from 'jsonc-parser';
import { parseModule } from 'magicast';

/**
 * Static (never executed) edits of user config files. JS/TS configs are parsed
 * with magicast (recast/babel) and edited by splicing text at AST positions, so
 * everything outside the touched spots stays byte-for-byte identical. Anything
 * of an unusual shape ends in a `{ manual }` snippet — never a false success.
 */

export type PluginTarget = 'vite' | 'webpack' | 'rollup' | 'rspack';

export interface PluginSpec {
  importFrom: string;
  importName: string;
  callArgs: string;
}

export type PluginEditResult = { code: string } | { manual: string };

const MARKER = 'bugsee-wizard';
// the marker must stand alone as a word: `bugsee-wizard-foo` is somebody else's comment
const MARKER_RE = /(?<![\w-])bugsee-wizard(?![\w-])/;
const CONFIG_EXTENSIONS = ['ts', 'mts', 'js', 'mjs', 'cjs', 'cts'] as const;

/** First existing `<base>.<ext>` in precedence order, as an absolute path. */
export async function findConfigFile(dir: string, base: string): Promise<string | undefined> {
  for (const ext of CONFIG_EXTENSIONS) {
    const candidate = join(dir, `${base}.${ext}`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next extension
    }
  }
  return undefined;
}

/** True when a *comment* (not a string/template) contains the wizard marker. */
export function hasBugseeMarker(source: string): boolean {
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source.charAt(i);
    const next = source.charAt(i + 1);
    if (c === '/' && next === '/') {
      let end = source.indexOf('\n', i);
      if (end === -1) end = n;
      if (MARKER_RE.test(source.slice(i, end))) return true;
      i = end;
    } else if (c === '/' && next === '*') {
      let end = source.indexOf('*/', i + 2);
      if (end === -1) end = n;
      if (MARKER_RE.test(source.slice(i, end))) return true;
      i = end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < n && source.charAt(i) !== c) {
        if (source.charAt(i) === '\\') i++;
        i++;
      }
      i++;
    } else {
      i++;
    }
  }
  return false;
}

// ---------------------------------------------------------------- AST access

export interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}

export function child(node: Node, key: string): Node | undefined {
  const v = node[key];
  return isNode(v) ? v : undefined;
}

export function children(node: Node, key: string): Array<Node | null> {
  const v = node[key];
  return Array.isArray(v) ? v.map((x) => (isNode(x) ? x : null)) : [];
}

const WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'ParenthesizedExpression',
]);

function unwrap(node: Node): Node {
  let cur = node;
  while (WRAPPERS.has(cur.type)) {
    const inner = child(cur, 'expression');
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

export function name(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'Identifier') return typeof node.name === 'string' ? node.name : undefined;
  if (node.type === 'StringLiteral') return typeof node.value === 'string' ? node.value : undefined;
  return undefined;
}

function isModuleExports(node: Node | undefined): boolean {
  if (node?.type !== 'MemberExpression') return false;
  const obj = child(node, 'object');
  const prop = child(node, 'property');
  return name(obj) === 'module' && name(prop) === 'exports' && node.computed !== true;
}

/** The expression a module exports as its config, or undefined. */
function exportedExpression(body: Node[]): { expr: Node; esm: boolean } | undefined {
  for (const stmt of body) {
    if (stmt.type === 'ExportDefaultDeclaration') {
      const decl = child(stmt, 'declaration');
      return decl ? { expr: decl, esm: true } : undefined;
    }
  }
  for (const stmt of body) {
    if (stmt.type !== 'ExpressionStatement') continue;
    const e = child(stmt, 'expression');
    if (e?.type === 'AssignmentExpression' && isModuleExports(child(e, 'left'))) {
      const right = child(e, 'right');
      return right ? { expr: right, esm: false } : undefined;
    }
  }
  return undefined;
}

function findDeclaration(body: Node[], id: string): Node | undefined {
  for (const stmt of body) {
    const decl = stmt.type === 'ExportNamedDeclaration' ? child(stmt, 'declaration') : stmt;
    if (decl?.type !== 'VariableDeclaration') continue;
    for (const d of children(decl, 'declarations')) {
      if (d && name(child(d, 'id')) === id) return child(d, 'init');
    }
  }
  return undefined;
}

/** Resolve the exported expression down to the config ObjectExpression. */
function resolveConfigObject(body: Node[], start: Node): Node | undefined {
  let cur = unwrap(start);
  for (let depth = 0; depth < 8; depth++) {
    if (cur.type === 'ObjectExpression') return cur;
    if (cur.type === 'Identifier') {
      const init = findDeclaration(body, name(cur) ?? '');
      if (!init) return undefined;
      cur = unwrap(init);
      continue;
    }
    if (cur.type === 'CallExpression') {
      const args = children(cur, 'arguments');
      const only = args.length === 1 ? args[0] : undefined;
      if (name(child(cur, 'callee')) !== 'defineConfig' || !only) return undefined;
      cur = unwrap(only);
      continue;
    }
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- splicing

interface Edit {
  at: number;
  remove: number;
  text: string;
}

function eolOf(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function lineIndent(source: string, pos: number): string {
  const lineStart = Math.max(source.lastIndexOf('\n', pos - 1) + 1, 0);
  return /^[ \t]*/.exec(source.slice(lineStart, pos))?.[0] ?? '';
}

function isMultiline(source: string, a: number, b: number): boolean {
  return source.slice(a, b).includes('\n');
}

/** Index just past a comma that follows `pos` (ignoring whitespace), or -1. */
function commaAfter(source: string, pos: number): number {
  let i = pos;
  while (i < source.length && /\s/.test(source.charAt(i))) i++;
  return source.charAt(i) === ',' ? i + 1 : -1;
}

/**
 * End-of-line index when only whitespace and a comment follow `pos` on its line, else `pos`.
 * New lines go after such a comment so it is never separated from the code it annotates.
 */
export function lineEndIfCommentTail(source: string, pos: number): number {
  const nl = source.indexOf('\n', pos);
  const end = nl === -1 ? source.length : nl;
  return /^[ \t]*(?:\/\/.*|\/\*.*?\*\/[ \t]*)?$/.test(source.slice(pos, end)) ? end : pos;
}

/** Append `text` as a new line after `last` (and its comma, if any), keeping trailing comments put. */
function appendLine(source: string, last: Node, text: string, eol: string): Edit[] {
  const indent = lineIndent(source, last.start);
  const comma = commaAfter(source, last.end);
  const lineEnd = lineEndIfCommentTail(source, comma === -1 ? last.end : comma);
  if (comma !== -1) return [{ at: lineEnd, remove: 0, text: `${eol}${indent}${text},` }];
  if (lineEnd === last.end) return [{ at: last.end, remove: 0, text: `,${eol}${indent}${text}` }];
  return [
    { at: last.end, remove: 0, text: ',' },
    { at: lineEnd, remove: 0, text: `${eol}${indent}${text}` },
  ];
}

function callsImport(arr: Node, importName: string): boolean {
  return children(arr, 'elements').some((e) => {
    const n = e ? unwrap(e) : undefined;
    return (
      (n?.type === 'CallExpression' || n?.type === 'NewExpression') &&
      name(child(n, 'callee')) === importName
    );
  });
}

/** Edits adding the plugin call; `[]` when it is already in the plugins array, undefined when unsupported. */
function pluginEdit(
  source: string,
  config: Node,
  spec: PluginSpec,
  eol: string,
): Edit[] | undefined {
  const call = `${spec.importName}(${spec.callArgs})`;
  const props = children(config, 'properties');
  if (props.some((p) => p === null)) return undefined;
  const nodes = props as Node[];
  const pluginsProp = nodes.find(
    (p) =>
      p.type === 'ObjectProperty' && p.computed !== true && name(child(p, 'key')) === 'plugins',
  );
  if (pluginsProp) {
    const value = child(pluginsProp, 'value');
    if (!value || unwrap(value).type !== 'ArrayExpression') return undefined;
    const arr = unwrap(value);
    if (callsImport(arr, spec.importName)) return [];
    return arrayEdit(source, arr, call, eol);
  }
  // a spread may already carry (and would be overridden by) plugins: not safe
  if (nodes.some((p) => p.type !== 'ObjectProperty' && p.type !== 'ObjectMethod')) return undefined;
  const prop = `plugins: [${call}]`;
  const last = nodes[nodes.length - 1];
  if (!last) return [{ at: config.start, remove: config.end - config.start, text: `{ ${prop} }` }];
  const comma = commaAfter(source, last.end);
  if (!isMultiline(source, config.start, config.end)) {
    return [
      comma === -1
        ? { at: last.end, remove: 0, text: `, ${prop}` }
        : { at: comma, remove: 0, text: ` ${prop},` },
    ];
  }
  return appendLine(source, last, prop, eol);
}

function arrayEdit(source: string, arr: Node, call: string, eol: string): Edit[] {
  const elements = children(arr, 'elements').filter((e): e is Node => e !== null);
  const last = elements[elements.length - 1];
  if (!last) return [{ at: arr.start + 1, remove: arr.end - arr.start - 2, text: call }];
  const comma = commaAfter(source, last.end);
  if (isMultiline(source, arr.start, arr.end)) return appendLine(source, last, call, eol);
  return [
    comma === -1
      ? { at: last.end, remove: 0, text: `, ${call}` }
      : { at: comma, remove: 0, text: ` ${call},` },
  ];
}

function importEdit(
  directives: Node[],
  body: Node[],
  esm: boolean,
  spec: PluginSpec,
  eol: string,
  source: string,
): Edit {
  const line = esm
    ? `import { ${spec.importName} } from '${spec.importFrom}'; // ${MARKER}`
    : `const { ${spec.importName} } = require('${spec.importFrom}'); // ${MARKER}`;
  let anchor: Node | undefined;
  for (const stmt of body) {
    if (esm ? stmt.type === 'ImportDeclaration' : isRequireDeclaration(stmt)) anchor = stmt;
  }
  const after = anchor ?? directives[directives.length - 1];
  if (after) {
    return { at: lineEndIfCommentTail(source, after.end), remove: 0, text: `${eol}${line}` };
  }
  return { at: 0, remove: 0, text: `${line}${eol}` };
}

export function collectBoundNames(node: Node | undefined, out: string[]): void {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      if (typeof node.name === 'string') out.push(node.name);
      return;
    case 'ObjectPattern':
      for (const p of children(node, 'properties')) {
        collectBoundNames(p?.type === 'ObjectProperty' ? child(p, 'value') : (p ?? undefined), out);
      }
      return;
    case 'ArrayPattern':
      for (const e of children(node, 'elements')) collectBoundNames(e ?? undefined, out);
      return;
    case 'RestElement':
      collectBoundNames(child(node, 'argument'), out);
      return;
    case 'AssignmentPattern':
      collectBoundNames(child(node, 'left'), out);
      return;
    default:
      return;
  }
}

/**
 * How `importName` is bound at the top level of the file:
 * - `none`: not bound;
 * - `exact`: only by the runtime binding we would add (`import { importName } from importFrom` or
 *   `const { importName } = require(importFrom)`);
 * - `conflict`: by anything else (default/namespace/type-only import, other module, a local
 *   declaration), where adding our import would redeclare the name.
 */
function bindingOf(body: Node[], spec: PluginSpec): 'none' | 'exact' | 'conflict' {
  const isFrom = (n: Node | undefined): boolean => name(n) === spec.importFrom;
  let exact = 0;
  let other = 0;
  const note = (isExact: boolean): void => {
    if (isExact) exact++;
    else other++;
  };
  for (const raw of body) {
    const stmt = raw.type === 'ExportNamedDeclaration' ? (child(raw, 'declaration') ?? raw) : raw;
    if (stmt.type === 'ImportDeclaration') {
      const declTypeOnly = stmt.importKind === 'type' || stmt.importKind === 'typeof';
      for (const sp of children(stmt, 'specifiers')) {
        if (name(child(sp ?? stmt, 'local')) !== spec.importName) continue;
        note(
          !declTypeOnly &&
            sp?.type === 'ImportSpecifier' &&
            sp.importKind !== 'type' &&
            sp.importKind !== 'typeof' &&
            isFrom(child(stmt, 'source')) &&
            name(child(sp, 'imported')) === spec.importName,
        );
      }
    } else if (stmt.type === 'VariableDeclaration') {
      for (const d of children(stmt, 'declarations')) {
        const id = d ? child(d, 'id') : undefined;
        const names: string[] = [];
        collectBoundNames(id, names);
        if (!d || !names.includes(spec.importName)) continue;
        const init = child(d, 'init');
        const viaRequire =
          init?.type === 'CallExpression' &&
          name(child(init, 'callee')) === 'require' &&
          isFrom(children(init, 'arguments')[0] ?? undefined) &&
          id?.type === 'ObjectPattern' &&
          children(id, 'properties').some(
            (pr) =>
              pr?.type === 'ObjectProperty' &&
              name(child(pr, 'key')) === spec.importName &&
              name(child(pr, 'value')) === spec.importName,
          );
        note(viaRequire === true && names.length === 1);
      }
    } else if (
      (stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') &&
      name(child(stmt, 'id')) === spec.importName
    ) {
      note(false);
    }
  }
  if (other > 0 || exact > 1) return 'conflict';
  return exact === 1 ? 'exact' : 'none';
}

export function isRequireDeclaration(stmt: Node): boolean {
  if (stmt.type !== 'VariableDeclaration') return false;
  return children(stmt, 'declarations').some((d) => {
    const init = d ? child(d, 'init') : undefined;
    return init?.type === 'CallExpression' && name(child(init, 'callee')) === 'require';
  });
}

function snippet(target: PluginTarget, spec: PluginSpec, cjs: boolean): string {
  const line = cjs
    ? `const { ${spec.importName} } = require('${spec.importFrom}'); // ${MARKER}`
    : `import { ${spec.importName} } from '${spec.importFrom}'; // ${MARKER}`;
  return `${line}\n\n// Add to the "plugins" array of your ${target} config:\n${spec.importName}(${spec.callArgs})`;
}

export function parses(code: string): boolean {
  try {
    parseModule(code);
    return true;
  } catch {
    return false;
  }
}

function looksCommonJs(source: string): boolean {
  return (
    /\bmodule\s*\.\s*exports\b|\brequire\s*\(/.test(source) &&
    !/^\s*(?:export|import)\s/m.test(source)
  );
}

/**
 * Add `<importName>(<callArgs>)` to the exported config's `plugins` array plus
 * the matching import/require. Idempotent; unsupported shapes -> `{ manual }`.
 */
export function addBundlerPlugin(
  original: string,
  target: PluginTarget,
  spec: PluginSpec,
): PluginEditResult {
  if (hasBugseeMarker(original)) return { code: original };
  // recast reports node positions against LF-normalised text, so edit that and restore CRLF after
  const crlf = original.includes('\r\n');
  let source = crlf ? original.replace(/\r\n/g, '\n') : original;
  // a BOM and a shebang line are not part of the module text: set them aside and put them back
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  source = source.slice(bom.length);
  let shebang = '';
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n');
    shebang = nl === -1 ? source : source.slice(0, nl + 1);
    source = source.slice(shebang.length);
  }
  const manualFor = (cjs: boolean): PluginEditResult => ({ manual: snippet(target, spec, cjs) });
  const guessCjs = looksCommonJs(source);

  let body: Node[];
  let directives: Node[];
  try {
    const program = parseModule(source).$ast as unknown;
    if (!isNode(program)) return manualFor(guessCjs);
    body = children(program, 'body').filter((n): n is Node => n !== null);
    directives = children(program, 'directives').filter((n): n is Node => n !== null);
  } catch {
    return manualFor(guessCjs);
  }

  const exported = exportedExpression(body);
  if (!exported) return manualFor(guessCjs);
  const cjs = !exported.esm;
  const config = resolveConfigObject(body, exported.expr);
  if (!config) return manualFor(cjs);

  // never add a second declaration of a name the file already binds some other way
  const binding = bindingOf(body, spec);
  if (binding === 'conflict') return manualFor(cjs);

  const eol = '\n';
  const plugin = pluginEdit(source, config, spec, eol);
  if (!plugin) return manualFor(cjs);
  const edits = [...plugin];
  if (binding === 'none') {
    edits.push(importEdit(directives, body, exported.esm, spec, eol, source));
  }
  // already wired up by hand (import + call, no marker): nothing to do
  if (edits.length === 0) return { code: original };

  let code = source;
  for (const e of edits.sort((a, b) => b.at - a.at)) {
    code = code.slice(0, e.at) + e.text + code.slice(e.at + e.remove);
  }
  if (!parses(code)) return manualFor(cjs);
  code = bom + shebang + code;
  return { code: crlf ? code.replace(/\n/g, '\r\n') : code };
}

// ---------------------------------------------------------------- JSON-C

/** Structural equality for JSON values (jsonc-parser builds prototype-less objects). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => jsonEqual(x, b[i]))
    );
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every(
        (k) =>
          Object.hasOwn(b, k) &&
          jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return a === b;
}

function detectIndent(source: string): { insertSpaces: boolean; tabSize: number } {
  const m = /^([ \t]+)\S/m.exec(source);
  const lead = m?.[1];
  if (!lead) return { insertSpaces: true, tabSize: 2 };
  if (lead.startsWith('\t')) return { insertSpaces: false, tabSize: 1 };
  return { insertSpaces: true, tabSize: lead.length };
}

/** Set a nested key in JSON-with-comments text, preserving comments/indent/EOL. */
export function setJsonCKey(source: string, path: string[], value: unknown): string {
  const tree = parseTree(source, [], { allowTrailingComma: true });
  const existing = tree ? findNodeAtLocation(tree, path) : undefined;
  if (existing && jsonEqual(getNodeValue(existing), value)) return source;
  const edits = modify(source, path, value, {
    formattingOptions: { ...detectIndent(source), eol: eolOf(source) },
  });
  return applyEdits(source, edits);
}

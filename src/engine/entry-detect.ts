import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { SdkRuntime } from './sdk-init-ast.js';

/**
 * Where a project's code starts running, found by static analysis only: package.json, an HTML file
 * and the file system are read, no project file is ever executed or imported. The answer is always
 * a path inside the package directory that exists.
 */
export interface EntryFile {
  /** Relative to the package directory, `/`-separated. */
  file: string;
  /** What pointed at it, for the plan and the logs. */
  via: string;
}

const SCRIPT_EXT_RE = /\.(?:[cm]?[jt]sx?)$/i;
const DECLARATION_RE = /\.d\.[cm]?ts$/i;
const EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'];
const SERVER_BASES = [
  'src/index',
  'src/main',
  'src/server',
  'src/app',
  'index',
  'main',
  'server',
  'app',
];
const BUN_BASES = [
  'index',
  'src/index',
  'main',
  'src/main',
  'server',
  'src/server',
  'app',
  'src/app',
];
const BROWSER_BASES = ['src/main', 'src/index', 'src/entry', 'main', 'index'];
const START_SCRIPTS = ['start', 'dev', 'serve'];
const BUILD_DIRS = ['dist', 'build', 'out', 'lib'];

const posix = (p: string): string => p.split(sep).join('/');

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/** A package-relative path for `rel` (resolved against `fromDir`), or undefined when it leaves the package. */
function inside(root: string, fromDir: string, rel: string): string | undefined {
  const abs = isAbsolute(rel) ? join(root, rel) : normalize(join(fromDir, rel));
  const back = relative(root, abs);
  if (back === '' || back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    return undefined;
  }
  return posix(back);
}

/** `file` when it is a real script inside the package. */
async function usable(root: string, rel: string | undefined): Promise<string | undefined> {
  if (rel === undefined || !SCRIPT_EXT_RE.test(rel) || DECLARATION_RE.test(rel)) return undefined;
  return (await exists(join(root, rel))) ? rel : undefined;
}

/** `dist/x.js` -> `src/x.ts` (the usual compiler layout), when that source exists. */
async function sourceOf(root: string, rel: string): Promise<string | undefined> {
  const parts = rel.split('/');
  const top = parts[0];
  if (parts.length < 2 || top === undefined || !BUILD_DIRS.includes(top)) return undefined;
  const base = parts.slice(1).join('/').replace(SCRIPT_EXT_RE, '');
  for (const ext of EXTENSIONS) {
    const candidate = `src/${base}.${ext}`;
    if (await exists(join(root, candidate))) return candidate;
  }
  return undefined;
}

/** The existing script a package.json path stands for: its TypeScript source when it is build output. */
async function resolveDeclared(root: string, declared: unknown): Promise<string | undefined> {
  if (typeof declared !== 'string') return undefined;
  const rel = inside(root, root, declared);
  if (rel === undefined || !SCRIPT_EXT_RE.test(rel)) return undefined;
  return (await sourceOf(root, rel)) ?? (await usable(root, rel));
}

/** Flags whose next word is their value, not a script to run (`node --import ./register.mjs app.js`). */
const VALUE_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '--watch-path',
  '--conditions',
  '-C',
  '-e',
  '--eval',
  '-p',
  '--print',
]);

/**
 * Script paths in a shell command, the last command of a chain first (`migrate && node server.js`
 * runs the server last). Flag values (`--import ./x.mjs`) and `NAME=value` words are not scripts.
 */
function scriptTokens(command: string): string[] {
  const out: string[] = [];
  for (const part of command.split(/&&|\|\||[;|]/).reverse()) {
    const words = part.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ''));
    for (let i = 0; i < words.length; i++) {
      const w = words[i] ?? '';
      if (VALUE_FLAGS.has(w)) i++;
      else if (w !== '' && !w.startsWith('-') && !w.includes('=') && SCRIPT_EXT_RE.test(w))
        out.push(w);
    }
  }
  return out;
}

async function readPackage(root: string): Promise<Record<string, unknown>> {
  try {
    const data: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function conventional(root: string, bases: readonly string[]): Promise<string | undefined> {
  for (const base of bases) {
    for (const ext of EXTENSIONS) {
      const rel = `${base}.${ext}`;
      if (!DECLARATION_RE.test(rel) && (await exists(join(root, rel)))) return rel;
    }
  }
  return undefined;
}

/** The first local module `<script src>` of an HTML file that names an existing script (never build output). */
async function htmlScript(root: string, htmlRel: string): Promise<string | undefined> {
  let html: string;
  try {
    html = await readFile(join(root, htmlRel), 'utf8');
  } catch {
    return undefined;
  }
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1] ?? '';
    // a classic script cannot take an import line: only module scripts are entries
    if (!/\btype\s*=\s*["']?module\b/i.test(attrs)) continue;
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const value = (src?.[1] ?? src?.[2] ?? '').split(/[?#]/)[0] ?? '';
    if (value === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) continue;
    const rel = inside(root, value.startsWith('/') ? root : join(root, dirname(htmlRel)), value);
    if (rel === undefined) continue;
    // generated output is rewritten by the next build: its source is the entry, or there is none
    if (BUILD_DIRS.includes(rel.split('/')[0] ?? '')) {
      const source = await sourceOf(root, rel);
      if (source !== undefined) return source;
      continue;
    }
    const found = await usable(root, rel);
    if (found !== undefined) return found;
  }
  return undefined;
}

export async function findEntry(root: string, runtime: SdkRuntime): Promise<EntryFile | undefined> {
  if (runtime === 'browser') {
    for (const html of ['index.html', 'src/index.html']) {
      const file = await htmlScript(root, html);
      if (file !== undefined) return { file, via: html };
    }
    const file = await conventional(root, BROWSER_BASES);
    return file === undefined ? undefined : { file, via: 'convention' };
  }

  const pkg = await readPackage(root);
  const scripts =
    typeof pkg.scripts === 'object' && pkg.scripts !== null
      ? (pkg.scripts as Record<string, unknown>)
      : {};
  for (const name of START_SCRIPTS) {
    const command = scripts[name];
    if (typeof command !== 'string') continue;
    for (const token of scriptTokens(command)) {
      const file = await resolveDeclared(root, token);
      if (file !== undefined) return { file, via: `scripts.${name}` };
    }
  }
  const bin = typeof pkg.bin === 'object' && pkg.bin !== null ? Object.values(pkg.bin)[0] : pkg.bin;
  const declared: Array<[string, unknown]> = [
    ['package.json main', pkg.main],
    ...(runtime === 'bun'
      ? ([['package.json module', pkg.module]] as Array<[string, unknown]>)
      : []),
    ['package.json bin', bin],
  ];
  for (const [via, value] of declared) {
    const file = await resolveDeclared(root, value);
    if (file !== undefined) return { file, via };
  }
  const file = await conventional(root, runtime === 'bun' ? BUN_BASES : SERVER_BASES);
  return file === undefined ? undefined : { file, via: 'convention' };
}

/**
 * Whether TypeScript already knows `import.meta.env`: Vite's client types named in tsconfig.json or
 * in a declaration file at the package root or in `src/` (where `vite-env.d.ts` lives).
 */
export async function hasViteClientTypes(root: string): Promise<boolean> {
  const mentions = async (file: string): Promise<boolean> =>
    readFile(join(root, file), 'utf8').then(
      (text) => text.includes('vite/client'),
      () => false,
    );
  const root_ = await readdir(root).catch(() => [] as string[]);
  for (const name of root_) {
    if (/^tsconfig(?:\..+)?\.json$/.test(name) && (await mentions(name))) return true;
  }
  for (const dir of ['.', 'src']) {
    const names = await readdir(join(root, dir)).catch(() => [] as string[]);
    for (const name of names) {
      if (DECLARATION_RE.test(name) && (await mentions(join(dir, name)))) return true;
    }
  }
  return false;
}

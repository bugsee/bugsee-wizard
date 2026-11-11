import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { stripHtmlComments, stripJsComments } from './js-text.js';
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
/** Service-worker and worker registration scripts: they run beside the app, they are not its entry. */
const WORKER_SCRIPT_RE =
  /(?:^|\/)[^/]*(?:service-?worker|register-?sw|\bsw\b|worker)[^/]*\.[cm]?[jt]sx?$/i;
const START_SCRIPTS = ['start', 'dev', 'serve'];
const BUILD_DIRS = ['dist', 'build', 'out', 'lib'];

/** Tool configuration, tests and process-manager files: scripts, but never the app. */
const NOT_APP_FILE_RE =
  /(?:^|\/)(?:ecosystem\.[^/]*|[^/]*\.(?:config|test|spec|setup|stories)\.[cm]?[jt]sx?)$/i;
const NOT_APP_DIR_RE = /(?:^|\/)(?:__tests__|__mocks__|tests?|spec|e2e|cypress)\//i;

/** A JavaScript/TypeScript file that can be an app's entry (not a declaration, config or test). */
function isAppFile(rel: string): boolean {
  return (
    SCRIPT_EXT_RE.test(rel) &&
    !DECLARATION_RE.test(rel) &&
    !NOT_APP_FILE_RE.test(rel) &&
    !NOT_APP_DIR_RE.test(rel)
  );
}

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
  if (rel === undefined || !isAppFile(rel)) return undefined;
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
  if (rel === undefined || !isAppFile(rel)) return undefined;
  const source = await sourceOf(root, rel);
  if (source !== undefined) return source;
  // generated output with no source to map back to: it is rewritten by the next build, never edit it
  return BUILD_DIRS.includes(rel.split('/')[0] ?? '') ? undefined : usable(root, rel);
}

/** Flags whose next word is their value, not a script to run (`node --import ./register.mjs app.js`). */
const VALUE_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '--env-file-if-exists',
  '--watch-path',
  '--conditions',
  '-C',
  '-c',
  '--config',
  '--tsconfig',
  '--project',
  '-p',
  '--print',
  '-e',
  '--eval',
]);

/**
 * The programs that run a script file. A command with none of them (rollup, webpack, vite, tsc,
 * esbuild, jest, pm2, ...) runs a tool, not the app, so the files in it are configuration or input.
 */
const RUNNERS = new Set([
  'node',
  'tsx',
  'ts-node',
  'ts-node-esm',
  'ts-node-dev',
  'node-dev',
  'nodemon',
  'vite-node',
  'babel-node',
  'esno',
  'jiti',
  'bun',
]);

/**
 * Script paths of the last command of a chain that runs one with a runner (`migrate && node server.js`
 * runs the server last). Flag values (`--import ./x.mjs`, `-c nodemon.json`), `NAME=value` words and
 * test runs (`node --test`) are not the app.
 */
function scriptTokens(command: string): string[] {
  for (const part of command.split(/&&|\|\||[;|]/).reverse()) {
    const words = part.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ''));
    const at = words.findIndex((w) => RUNNERS.has(w.replace(/^.*\//, '')));
    if (at === -1) continue;
    if (words.some((w) => w === '--test' || w.startsWith('--test-'))) return [];
    const out: string[] = [];
    for (let i = at + 1; i < words.length; i++) {
      const w = words[i] ?? '';
      if (VALUE_FLAGS.has(w)) i++;
      else if (w !== '' && !w.startsWith('-') && !w.includes('=') && isAppFile(w)) out.push(w);
    }
    // only the last command that runs a script is the app; an earlier one is a setup step
    if (out.length > 0) return out;
  }
  return [];
}

/** The script files the `start`/`dev`/`serve` scripts run with a runner (`tsx watch playground/main.ts` -> `playground/main.ts`). */
export function scriptFiles(scripts: Record<string, unknown>): string[] {
  return START_SCRIPTS.flatMap((n) => {
    const command = scripts[n];
    return typeof command === 'string' ? scriptTokens(command) : [];
  });
}

/** Whether a `start`/`dev`/`serve` script runs a script file with a runner (`nodemon index.js`), i.e. the project is an app. */
export function scriptsRunAFile(scripts: Record<string, unknown>): boolean {
  return START_SCRIPTS.some((n) => {
    const command = scripts[n];
    return typeof command === 'string' && scriptTokens(command).length > 0;
  });
}

async function readPackage(root: string): Promise<Record<string, unknown>> {
  try {
    const data: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The one conventionally named entry. Different names present at once (`src/index.ts` and
 * `src/server.ts`) are ambiguous: no guess. The same name in several extensions picks TypeScript.
 */
async function conventional(root: string, bases: readonly string[]): Promise<string | undefined> {
  const found: string[] = [];
  for (const base of bases) {
    for (const ext of EXTENSIONS) {
      const rel = `${base}.${ext}`;
      if (isAppFile(rel) && (await exists(join(root, rel)))) {
        found.push(rel);
        break;
      }
    }
  }
  return found.length === 1 ? found[0] : undefined;
}

/** The first local module `<script src>` of an HTML file that names an existing script (never build output). */
/**
 * The `<script>` elements of a page, found with plain index searches (one pass, no backtracking: a
 * page with thousands of unclosed tags cannot make a pattern rescan the rest of the text each time).
 */
function* scriptTags(html: string): Generator<{ attrs: string; body: string }> {
  // ASCII-only lower case keeps every index valid in `html` (toLowerCase() changes the length of İ)
  const lower = html.replace(/[A-Z]/g, (c) => c.toLowerCase());
  let at = 0;
  for (;;) {
    const open = lower.indexOf('<script', at);
    if (open === -1) return;
    const afterName = open + '<script'.length;
    // `<scripts>` or `<script-x>` is another element
    if (/[\w-]/.test(html.charAt(afterName))) {
      at = afterName;
      continue;
    }
    const gt = html.indexOf('>', afterName);
    if (gt === -1) return;
    const close = lower.indexOf('</script', gt + 1);
    yield {
      attrs: html.slice(afterName, gt),
      body: html.slice(gt + 1, close === -1 ? html.length : close),
    };
    if (close === -1) return;
    const end = html.indexOf('>', close);
    if (end === -1) return;
    at = end + 1;
  }
}

async function htmlScript(root: string, htmlRel: string): Promise<string | undefined> {
  let html: string;
  try {
    html = await readFile(join(root, htmlRel), 'utf8');
  } catch {
    return undefined;
  }
  for (const tag of scriptTags(stripHtmlComments(html))) {
    const attrs = tag.attrs;
    // a classic script cannot take an import line: only module scripts are entries
    if (!/\btype\s*=\s*["']?module\b/i.test(attrs)) continue;
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    // an inline module script is followed to the first local file it imports
    const inline = /^\s*import\s+(?:[^'"]*?\bfrom\s*)?["']([^"']+)["']/m.exec(
      stripJsComments(tag.body),
    )?.[1];
    const value =
      (src?.[1] ?? src?.[2] ?? (src === null ? (inline ?? '') : '')).split(/[?#]/)[0] ?? '';
    if (
      value === '' ||
      (src === null && !/^[./]/.test(value)) ||
      /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)
    )
      continue;
    const rel = inside(root, value.startsWith('/') ? root : join(root, dirname(htmlRel)), value);
    if (rel === undefined || WORKER_SCRIPT_RE.test(rel)) continue;
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
    // tsconfig.node.json belongs to the config files (vite.config.ts), not to the app
    if (
      /^tsconfig(?:\..+)?\.json$/.test(name) &&
      !/\.node\.json$/.test(name) &&
      (await mentions(name))
    ) {
      return true;
    }
  }
  for (const dir of ['.', 'src']) {
    const names = await readdir(join(root, dir)).catch(() => [] as string[]);
    for (const name of names) {
      if (DECLARATION_RE.test(name) && (await mentions(join(dir, name)))) return true;
    }
  }
  return false;
}

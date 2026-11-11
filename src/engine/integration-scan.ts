import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { stripHtmlComments, stripJsComments } from './js-text.js';
import { isRuntimeSdkPackage } from './sdk-packages.js';

/**
 * Is the Bugsee SDK already set up somewhere in the project? A second `launch()` added at the entry
 * would run first and turn the app's own, configured launch into a silent no-op, so an existing
 * integration anywhere (a dependency on another runtime package, a static or dynamic import in any
 * source file) means the wizard leaves the code alone. Static text scan, bounded; nothing is executed.
 */
export interface Integration {
  /** Where it was found, for the message shown to the user. */
  where: string;
}

/** The scan could not finish, and why: the project is neither "integrated" nor "not integrated". */
export interface UnfinishedScan {
  unknown: string;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.bugsee',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.turbo',
  '.angular',
  '.vercel',
  'storybook-static',
  // hidden tool state and caches hold no app code and can hold thousands of files (other hidden
  // directories, like .storybook, are read: they do hold app code)
  '.yarn',
  '.cache',
  '.vite',
  '.nx',
  '.parcel-cache',
  '.docusaurus',
  '.pnpm-store',
  '.expo',
  '.idea',
  '.vscode',
  '.github',
  // not source: media, static files and vendored output can be huge and never hold the app's launch
  'assets',
  'static',
  'public',
  'vendor',
]);
/** Read first: where an app's own code lives, so the bound cannot hide an integration there. */
/** Hidden directories that do hold app code. Every other hidden directory is tool state or a copy of the app (.history, worktrees, .open-next). */
const HIDDEN_APP_DIRS = new Set(['.storybook', '.vitepress', '.vuepress']);
const PRIORITY_DIRS = ['src', 'app', 'lib', 'pages', 'components', 'server', 'client'];
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html)$/i;
const MAX_FILES = 3000;
const MAX_BYTES = 512 * 1024;

/** Type-only loads are erased at build time: they do not run the SDK. */
/**
 * The head of a type-only statement, tested on a short window before a load (never on the whole text,
 * so nothing can rescan a long file for every `import type` in it): `import type ...`, `export type ...`,
 * or `import { type A, type B as C }` where every specifier is type-only.
 */
const TYPE_STATEMENT_RE = /^(?:import|export)\s+type\b/;
const ALL_TYPE_SPECIFIERS_RE =
  /^import\s*\{\s*type\s+[\w$]+(?:\s+as\s+[\w$]+)?(?:\s*,\s*type\s+[\w$]+(?:\s+as\s+[\w$]+)?)*[\s,]*\}\s*$/;
const WINDOW = 400;

function isTypeOnlyLoad(code: string, at: number): boolean {
  // only a `from '...'` clause can belong to an `import type`: import() and require() are never erased
  if (!code.startsWith('from', at)) return false;
  const window = code.slice(Math.max(0, at - WINDOW), at);
  const start = Math.max(window.lastIndexOf('import'), window.lastIndexOf('export'));
  if (start === -1) return false;
  const head = window.slice(start);
  // a `;` before the clause ends the statement: this `from` belongs to a later one
  if (head.includes(';')) return false;
  return TYPE_STATEMENT_RE.test(head) || ALL_TYPE_SPECIFIERS_RE.test(head);
}
const LOAD_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](@bugsee\/[\w.-]+)(?:\/[^'"]*)?['"]/g;

const MARKUP_RE = /\.(?:vue|svelte|astro|html)$/i;

function loadsRuntimePackage(text: string, markup: boolean): boolean {
  const code = stripJsComments(markup ? stripHtmlComments(text) : text, { markup });
  for (const m of code.matchAll(LOAD_RE)) {
    if (isRuntimeSdkPackage(m[1]) && !isTypeOnlyLoad(code, m.index ?? 0)) return true;
  }
  return false;
}

async function dependencyIntegration(root: string, own: string): Promise<Integration | undefined> {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field];
    if (typeof deps !== 'object' || deps === null) continue;
    const name = Object.keys(deps).find((d) => d !== own && isRuntimeSdkPackage(d));
    if (name !== undefined) return { where: `package.json (${name})` };
  }
  return undefined;
}

export async function findExistingIntegration(
  root: string,
  ownPackage: string,
  /** Receives a note for each file skipped on purpose (too large to read), to show the user. */
  notes: string[] = [],
): Promise<Integration | UnfinishedScan | undefined> {
  const dep = await dependencyIntegration(root, ownPackage);
  if (dep) return dep;
  let seen = 0;
  let capped: string | undefined;
  const walk = async (dir: string, rel: string): Promise<Integration | undefined> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    // a directory with its own .git is another repository (a nested clone or a worktree), not this project
    if (rel !== '' && entries.some((e) => e.name === '.git')) return undefined;
    const rank = (name: string): number => {
      const at = PRIORITY_DIRS.indexOf(name);
      return rel === '' && at !== -1 ? at : PRIORITY_DIRS.length;
    };
    for (const e of entries.sort(
      (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name),
    )) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        // tool state and caches (.yarn, .cache, .nx, ...) hold no app code, and can hold thousands of files
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && !HIDDEN_APP_DIRS.has(e.name)))
          continue;
        const found = await walk(join(dir, e.name), path);
        if (found) return found;
        if (capped !== undefined && seen > MAX_FILES) return undefined;
      } else if (e.isFile() && SOURCE_EXT_RE.test(e.name) && !e.name.endsWith('.d.ts')) {
        if (++seen > MAX_FILES) {
          capped = `more than ${MAX_FILES} source files`;
          return undefined;
        }
        const abs = join(dir, e.name);
        const size = await stat(abs).then(
          (st) => st.size,
          () => undefined,
        );
        // a very large source file is generated output (a schema, a client): skipped, and said so
        if (size !== undefined && size > MAX_BYTES) {
          notes.push(`skipped ${path} (larger than ${MAX_BYTES / 1024} KB)`);
          continue;
        }
        // a file that cannot be read (unreadable, gone) leaves the scan unfinished
        const text = await readFile(abs, 'utf8').catch(() => undefined);
        if (text === undefined) {
          capped ??= `could not read ${path}`;
          continue;
        }
        if (loadsRuntimePackage(text, MARKUP_RE.test(e.name))) return { where: path };
      }
    }
    return undefined;
  };
  const found = await walk(root, '');
  if (found) return found;
  // an unfinished scan proves nothing: the caller must not act as if the project had no integration
  return capped === undefined ? undefined : { unknown: capped };
}

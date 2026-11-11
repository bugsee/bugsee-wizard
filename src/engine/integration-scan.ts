import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { stripJsComments } from './js-text.js';
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
  // not source: media, static files and vendored output can be huge and never hold the app's launch
  'assets',
  'static',
  'public',
  'vendor',
]);
/** Read first: where an app's own code lives, so the bound cannot hide an integration there. */
const PRIORITY_DIRS = ['src', 'app', 'lib', 'pages', 'components', 'server', 'client'];
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html)$/i;
const MAX_FILES = 3000;
const MAX_BYTES = 512 * 1024;

/** Type-only loads are erased at build time: they do not run the SDK. */
const TYPE_ONLY_RE = [
  /\b(?:import|export)\s+type\b[^;'"]*?from\s*['"][^'"]+['"]/g,
  // every specifier is `type X` or `type X as Y`: one unambiguous shape, so it cannot backtrack badly
  /\bimport\s*\{\s*type\s+[\w$]+(?:\s+as\s+[\w$]+)?(?:\s*,\s*type\s+[\w$]+(?:\s+as\s+[\w$]+)?)*[\s,]*\}\s*from\s*['"][^'"]+['"]/g,
];
const LOAD_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](@bugsee\/[\w.-]+)(?:\/[^'"]*)?['"]/g;

function loadsRuntimePackage(text: string): boolean {
  const code = TYPE_ONLY_RE.reduce((t, re) => t.replace(re, ''), stripJsComments(text));
  for (const m of code.matchAll(LOAD_RE)) {
    if (isRuntimeSdkPackage(m[1])) return true;
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
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        const found = await walk(join(dir, e.name), path);
        if (found) return found;
        if (capped !== undefined && seen > MAX_FILES) return undefined;
      } else if (e.isFile() && SOURCE_EXT_RE.test(e.name) && !e.name.endsWith('.d.ts')) {
        if (++seen > MAX_FILES) {
          capped = `more than ${MAX_FILES} source files`;
          return undefined;
        }
        const abs = join(dir, e.name);
        // a file that cannot be checked (too big, unreadable, gone) leaves the scan unfinished
        const text = await stat(abs)
          .then(
            async (st) => (st.size > MAX_BYTES ? undefined : readFile(abs, 'utf8')),
            () => undefined,
          )
          .catch(() => undefined);
        if (text === undefined) {
          capped ??= `could not read ${path} (unreadable or larger than ${MAX_BYTES / 1024} KB)`;
          continue;
        }
        if (loadsRuntimePackage(text)) return { where: path };
      }
    }
    return undefined;
  };
  const found = await walk(root, '');
  if (found) return found;
  // an unfinished scan proves nothing: the caller must not act as if the project had no integration
  return capped === undefined ? undefined : { unknown: capped };
}

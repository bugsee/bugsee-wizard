import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
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

/** `import type … from '@bugsee/x'` is erased at build time: it does not run the SDK. */
const TYPE_IMPORT_RE = /\bimport\s+type\b[^;'"]*?from\s*['"][^'"]+['"]/g;
const LOAD_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](@bugsee\/[\w.-]+)(?:\/[^'"]*)?['"]/g;

function loadsRuntimePackage(text: string): boolean {
  for (const m of text.replace(TYPE_IMPORT_RE, '').matchAll(LOAD_RE)) {
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
): Promise<Integration | 'unknown' | undefined> {
  const dep = await dependencyIntegration(root, ownPackage);
  if (dep) return dep;
  let seen = 0;
  let capped = false;
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
        if (SKIP_DIRS.has(e.name)) continue;
        const found = await walk(join(dir, e.name), path);
        if (found) return found;
        if (capped) return undefined;
      } else if (e.isFile() && SOURCE_EXT_RE.test(e.name) && !e.name.endsWith('.d.ts')) {
        if (++seen > MAX_FILES) {
          capped = true;
          return undefined;
        }
        const abs = join(dir, e.name);
        if ((await stat(abs)).size > MAX_BYTES) continue;
        if (loadsRuntimePackage(await readFile(abs, 'utf8'))) return { where: path };
      }
    }
    return undefined;
  };
  const found = await walk(root, '');
  if (found) return found;
  // an unfinished scan proves nothing: the caller must not act as if the project had no integration
  return capped ? 'unknown' : undefined;
}

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

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
]);
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html)$/i;
const MAX_FILES = 3000;
const MAX_BYTES = 512 * 1024;
/** Build tooling, not the runtime SDK. */
const TOOLING_RE = /^@bugsee\/(?:cli|bugsee-cli|[\w-]*plugin[\w-]*)$/;

/** `import type … from '@bugsee/x'` is erased at build time: it does not run the SDK. */
const TYPE_IMPORT_RE = /\bimport\s+type\b[^;'"]*?from\s*['"][^'"]+['"]/g;
const LOAD_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](@bugsee\/[\w.-]+)(?:\/[^'"]*)?['"]/g;

function loadsRuntimePackage(text: string): boolean {
  for (const m of text.replace(TYPE_IMPORT_RE, '').matchAll(LOAD_RE)) {
    if (!TOOLING_RE.test(m[1] ?? '')) return true;
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
    const name = Object.keys(deps).find(
      (d) => d.startsWith('@bugsee/') && d !== own && !TOOLING_RE.test(d),
    );
    if (name !== undefined) return { where: `package.json (${name})` };
  }
  return undefined;
}

export async function findExistingIntegration(
  root: string,
  ownPackage: string,
): Promise<Integration | undefined> {
  const dep = await dependencyIntegration(root, ownPackage);
  if (dep) return dep;
  let seen = 0;
  const walk = async (dir: string, rel: string): Promise<Integration | undefined> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        const found = await walk(join(dir, e.name), path);
        if (found) return found;
      } else if (e.isFile() && SOURCE_EXT_RE.test(e.name) && !e.name.endsWith('.d.ts')) {
        if (++seen > MAX_FILES) return undefined;
        const abs = join(dir, e.name);
        if ((await stat(abs)).size > MAX_BYTES) continue;
        if (loadsRuntimePackage(await readFile(abs, 'utf8'))) return { where: path };
      }
    }
    return undefined;
  };
  return walk(root, '');
}

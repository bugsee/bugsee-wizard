import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface WorkspacePackage {
  dir: string;
  name: string;
}
export interface Workspace {
  root: string;
  packages: WorkspacePackage[];
}

const MAX_DEPTH = 10;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readPnpmWorkspace(root: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = parseYaml(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Workspace globs declared at `dir`, or undefined when `dir` is not a workspace root. */
async function workspaceGlobs(dir: string): Promise<string[] | undefined> {
  const pnpm = await readPnpmWorkspace(dir);
  if (pnpm && Array.isArray(pnpm.packages)) return stringList(pnpm.packages);
  const pj = await readJson(join(dir, 'package.json'));
  const ws = pj?.workspaces;
  if (Array.isArray(ws)) return stringList(ws);
  if (isRecord(ws) && Array.isArray(ws.packages)) return stringList(ws.packages);
  return undefined;
}

function segmentRegExp(seg: string): RegExp {
  const escaped = seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function descendants(dir: string, out: string[]): Promise<void> {
  for (const name of await subdirs(dir)) {
    const child = join(dir, name);
    out.push(child);
    await descendants(child, out);
  }
}

/** Expands one glob (segments with `*`, literals, trailing `/**`) to candidate directories. */
async function expandGlob(root: string, glob: string): Promise<string[]> {
  const segs = glob.replace(/^\.\//, '').split('/').filter(Boolean);
  let level = [root];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as string;
    const next: string[] = [];
    if (seg === '**') {
      for (const base of level) {
        next.push(base);
        await descendants(base, next);
      }
    } else if (seg.includes('*')) {
      const re = segmentRegExp(seg);
      for (const base of level) {
        for (const name of await subdirs(base)) if (re.test(name)) next.push(join(base, name));
      }
    } else {
      for (const base of level) next.push(join(base, seg));
    }
    level = next;
  }
  return level;
}

async function listPackages(root: string, globs: string[]): Promise<WorkspacePackage[]> {
  const included = new Set<string>();
  const excluded = new Set<string>();
  for (const glob of globs) {
    const negated = glob.startsWith('!');
    const dirs = await expandGlob(root, negated ? glob.slice(1) : glob);
    for (const d of dirs) (negated ? excluded : included).add(d);
  }
  const out: WorkspacePackage[] = [];
  for (const d of [...included].sort()) {
    if (excluded.has(d) || d === root) continue;
    const name = (await readJson(join(d, 'package.json')))?.name;
    if (typeof name === 'string' && name !== '') out.push({ dir: d, name });
  }
  return out;
}

/** Finds the nearest workspace root at or above `startDir` and lists its packages. */
export async function findWorkspace(startDir: string): Promise<Workspace | null> {
  let current = startDir;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const globs = await workspaceGlobs(current);
    if (globs) return { root: current, packages: await listPackages(current, globs) };
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

function rangeOf(pj: Record<string, unknown>, dep: string): string | undefined {
  for (const field of DEP_FIELDS) {
    const section = pj[field];
    if (isRecord(section) && typeof section[dep] === 'string') return section[dep];
  }
  return undefined;
}

async function resolveCatalog(
  pkgDir: string,
  dep: string,
  catalogName: string,
): Promise<string | undefined> {
  const ws = await findPnpmWorkspaceFile(pkgDir);
  if (!ws) return undefined;
  let table: unknown;
  if (catalogName === '' || catalogName === 'default') {
    table = ws.catalog ?? (isRecord(ws.catalogs) ? ws.catalogs.default : undefined);
  } else {
    table = isRecord(ws.catalogs) ? ws.catalogs[catalogName] : undefined;
  }
  const v = isRecord(table) ? table[dep] : undefined;
  return typeof v === 'string' ? v : undefined;
}

async function findPnpmWorkspaceFile(
  startDir: string,
): Promise<Record<string, unknown> | undefined> {
  let current = startDir;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const ws = await readPnpmWorkspace(current);
    if (ws) return ws;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * Reads `dep`'s range from `pkgDir/package.json`. `catalog:` / `catalog:<name>` are resolved
 * from pnpm-workspace.yaml; `workspace:*`/`^`/`~`/`<range>` resolve to the target workspace
 * package's own `version`. Returns undefined when nothing can be resolved.
 */
export async function resolveDependencyVersion(
  pkgDir: string,
  dep: string,
): Promise<string | undefined> {
  const pj = await readJson(join(pkgDir, 'package.json'));
  if (!pj) return undefined;
  const range = rangeOf(pj, dep);
  if (range === undefined) return undefined;
  if (range.startsWith('catalog:'))
    return resolveCatalog(pkgDir, dep, range.slice('catalog:'.length));
  if (range.startsWith('workspace:')) {
    const ws = await findWorkspace(pkgDir);
    const target = ws?.packages.find((p) => p.name === dep);
    if (!target) return undefined;
    const version = (await readJson(join(target.dir, 'package.json')))?.version;
    return typeof version === 'string' ? version : undefined;
  }
  return range;
}

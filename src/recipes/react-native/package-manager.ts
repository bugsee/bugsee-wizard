import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runChild } from '../../core/run-child.js';

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

const LOCKFILE_BY_MANAGER: ReadonlyArray<{ file: string; manager: PackageManager }> = [
  // Bun and pnpm checked first — both can also produce a `package-lock.json`
  // alongside their own lockfile in some setups, so the more specific lock
  // wins. Yarn last because RN's default historically used yarn. Bun 1.2+ writes the text
  // `bun.lock`; older Bun wrote the binary `bun.lockb`.
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'yarn.lock', manager: 'yarn' },
];

const MAX_PARENTS = 8;

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** A directory that owns the lockfile of the workspace the app sits in (not just any parent). */
async function isWorkspaceRoot(dir: string): Promise<boolean> {
  if (await fileExists(path.join(dir, 'pnpm-workspace.yaml'))) return true;
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
      workspaces?: unknown;
    };
    return pkg.workspaces !== undefined;
  } catch {
    return false;
  }
}

/**
 * The lockfile of the app: in the app directory, or in a parent that is the root of a workspace
 * the app belongs to (a monorepo keeps one lockfile at its root). A stray lockfile further up
 * (a home directory, an unrelated project) is not ours: it would run the wrong install.
 */
/** Paths compare case-insensitively on Windows. */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function findLockfile(
  rnRoot: string,
): Promise<{ dir: string; manager: PackageManager } | null> {
  const start = path.resolve(rnRoot);
  const home = path.resolve(os.homedir());
  let dir = start;
  for (let i = 0; i <= MAX_PARENTS; i++) {
    if (dir !== start && samePath(dir, home)) break;
    for (const { file, manager } of LOCKFILE_BY_MANAGER) {
      if (await fileExists(path.join(dir, file))) {
        if (dir === start || (await isWorkspaceRoot(dir))) return { dir, manager };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Detect the package manager in use for `rnRoot` by looking for the lockfile each manager
 * produces, in the app directory and its parents. Falls back to `npm` when none is found (the most
 * universal default).
 */
export async function detectPackageManager(rnRoot: string): Promise<PackageManager> {
  return (await findLockfile(rnRoot))?.manager ?? 'npm';
}

/** Where the lockfile (and a pnpm-workspace.yaml) lives; the app directory when there is none. */
export async function findLockfileRoot(rnRoot: string): Promise<string> {
  return (await findLockfile(rnRoot))?.dir ?? path.resolve(rnRoot);
}

const PROBE_TIMEOUT_MS = 5000;

const onPathCache = new Map<PackageManager, boolean>();

export function isManagerOnPath(manager: PackageManager): boolean {
  const cached = onPathCache.get(manager);
  if (cached !== undefined) return cached;
  try {
    // on Windows npm/yarn/pnpm/bun are .cmd shims that cannot be spawned without a shell; the
    // manager comes from a closed set and the arguments are fixed: no injection path
    // (one command string with the shell: an args array plus shell: true raises Node's DEP0190)
    // bounded, like the pod probe: a corepack shim that downloads a pinned version must not hang
    // the prompt
    const result =
      process.platform === 'win32'
        ? spawnSync(`${manager} --version`, {
            stdio: 'ignore',
            shell: true,
            timeout: PROBE_TIMEOUT_MS,
          })
        : spawnSync(manager, ['--version'], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
    // a timed-out probe is unavailable for now but not cached: a slow-but-working manager must
    // not read as "not found" for the rest of the process
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') return false;
    const ok = result.status === 0;
    onPathCache.set(manager, ok);
    return ok;
  } catch {
    onPathCache.set(manager, false);
    return false;
  }
}

/** Reset the on-PATH cache — for tests. */
export function _resetManagerOnPathCache(): void {
  onPathCache.clear();
}

export async function runInstall(
  manager: PackageManager,
  cwd: string,
  forwardStdout: boolean,
): Promise<void> {
  // Every manager's "install everything in package.json" command is plain
  // `install`. We've already edited package.json to add the dep, so no
  // manager-specific `add` subcommand (which would double-write the version).
  await runChild(manager, ['install'], { cwd, forwardStdout });
}

import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { runChild } from '../../core/run-child.js';

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

const LOCKFILE_BY_MANAGER: ReadonlyArray<{ file: string; manager: PackageManager }> = [
  // Bun and pnpm checked first — both can also produce a `package-lock.json`
  // alongside their own lockfile in some setups, so the more specific lock
  // wins. Yarn last because RN's default historically used yarn.
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'yarn.lock', manager: 'yarn' },
];

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the package manager in use at `rnRoot` by looking for the
 * lockfile each manager produces. Falls back to `npm` when no lockfile
 * is present (the most universal default).
 */
export async function detectPackageManager(rnRoot: string): Promise<PackageManager> {
  for (const { file, manager } of LOCKFILE_BY_MANAGER) {
    if (await fileExists(path.join(rnRoot, file))) return manager;
  }
  return 'npm';
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

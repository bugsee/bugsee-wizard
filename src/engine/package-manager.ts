import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type PackageManagerName = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'deno';

export interface DetectedPackageManager {
  name: PackageManagerName;
  /** Directory the lockfile was found in. */
  root: string;
  /**
   * Arguments for the package manager executable (without the executable itself).
   * The install is expected to run in the package directory, so no workspace-root
   * flag (`-w` / `-W`) is added; callers that install at a workspace root decide that.
   */
  installArgs: (pkgs: string[], dev: boolean) => string[];
}

const MAX_DEPTH = 10;

const LOCKFILES: ReadonlyArray<readonly [string, PackageManagerName]> = [
  ['package-lock.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['deno.lock', 'deno'],
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function installArgsFor(name: PackageManagerName): (pkgs: string[], dev: boolean) => string[] {
  switch (name) {
    case 'npm':
      return (pkgs, dev) => ['install', ...(dev ? ['-D'] : []), ...pkgs];
    case 'deno':
      return (pkgs, dev) => ['add', ...(dev ? ['--dev'] : []), ...pkgs.map((p) => `npm:${p}`)];
    default:
      return (pkgs, dev) => ['add', ...(dev ? ['-D'] : []), ...pkgs];
  }
}

/**
 * Walks up from `startDir` (at most 10 directories) to the nearest directory holding a
 * lockfile. Two different package managers' lockfiles in one directory is ambiguous => null.
 */
export async function detectPackageManager(
  startDir: string,
): Promise<DetectedPackageManager | null> {
  let current = startDir;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const found = new Set<PackageManagerName>();
    for (const [file, name] of LOCKFILES) {
      if (await exists(join(current, file))) found.add(name);
    }
    if (found.size > 1) return null;
    const [name] = found;
    if (name) return { name, root: current, installArgs: installArgsFor(name) };
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

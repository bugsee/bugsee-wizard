import { spawn, spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

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

const onPathCache = new Map<PackageManager, boolean>();

export function isManagerOnPath(manager: PackageManager): boolean {
  const cached = onPathCache.get(manager);
  if (cached !== undefined) return cached;
  try {
    const result = spawnSync(manager, ['--version'], { stdio: 'ignore' });
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
  // Each manager's "install everything in package.json" command. We've
  // already edited package.json to add the dep, so a plain install is
  // enough — no need for the manager-specific `add` subcommand which
  // would double-write the version specifier.
  const args: string[] =
    manager === 'yarn'
      ? ['install']
      : manager === 'pnpm'
        ? ['install']
        : manager === 'bun'
          ? ['install']
          : ['install'];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(manager, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    if (forwardStdout) {
      child.stdout?.on('data', (chunk: Buffer) => {
        process.stdout.write(chunk);
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.trim().split('\n').slice(-10).join('\n');
      reject(new Error(`${manager} install exited with code ${code}${tail ? `\n${tail}` : ''}`));
    });
  });
}

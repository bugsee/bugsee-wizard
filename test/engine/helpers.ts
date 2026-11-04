import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManifestEntry } from '../../src/engine/manifest.js';
import type { DetectedPackageManager } from '../../src/engine/package-manager.js';
import type { RecipeContext } from '../../src/engine/recipe.js';

export async function makeTmp(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'bugsee-engine-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export interface LoggedCtx extends RecipeContext {
  readonly entries: ManifestEntry[];
  readonly logs: string[];
}

/** A RecipeContext over a real directory; everything logged or recorded is captured for assertions. */
export function makeCtx(dir: string, over: Partial<RecipeContext> = {}): LoggedCtx {
  const logs: string[] = [];
  const entries: ManifestEntry[] = [];
  const sink = (m: string): void => {
    logs.push(m);
  };
  return {
    cwd: dir,
    debug: false,
    dryRun: false,
    nonInteractive: true,
    json: false,
    ignoreGitChanges: false,
    yes: false,
    kind: 'javascript',
    tokens: {},
    log: { info: sink, warn: sink, error: sink, success: sink, step: sink, debug: sink },
    packageDir: dir,
    packageManager: null,
    token: 'tok_SECRET_123',
    manifest: { record: (e) => entries.push(e) },
    entries,
    logs,
    ...over,
  };
}

export function npmAt(root: string): DetectedPackageManager {
  return {
    name: 'npm',
    root,
    installArgs: (pkgs, dev) => ['install', ...(dev ? ['-D'] : []), ...pkgs],
  };
}

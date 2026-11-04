import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Logger } from '../core/logger.js';
import { runChildOutput } from '../core/run-child.js';
import { loadManifest } from '../engine/manifest.js';
import { CancelledError } from '../engine/noninteractive.js';

export interface GitState {
  /** Inside a git working tree. */
  readonly repo: boolean;
  /** Paths `git status` reports as changed or untracked (relative to `root`). */
  readonly changed: readonly string[];
  /** The repository's top-level directory (absolute), when inside one. */
  readonly root?: string;
}

export type RunOutput = (
  cmd: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<string>;

const SHOWN_FILES = 10;

/** Paths from `git status --porcelain=v1 -z`; a rename/copy's original name is skipped. */
export function parsePorcelainZ(out: string): string[] {
  const fields = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] ?? '';
    if (f.length < 4) continue;
    paths.push(f.slice(3));
    const xy = f.slice(0, 2);
    if (xy.includes('R') || xy.includes('C')) i++;
  }
  return paths;
}

/** Ask git (never through a shell) whether `dir` is in a working tree and what is uncommitted. */
export async function probeGit(dir: string, run: RunOutput = runChildOutput): Promise<GitState> {
  let inside: string;
  try {
    inside = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
  } catch {
    return { repo: false, changed: [] }; // not a repository, or git is not installed
  }
  if (inside.trim() !== 'true') return { repo: false, changed: [] };
  const root = (await run('git', ['rev-parse', '--show-toplevel'], { cwd: dir })).trim();
  // -uall: list every untracked file, not just its collapsed new directory
  const status = await run('git', ['status', '--porcelain=v1', '-z', '-uall'], { cwd: dir });
  return { repo: true, changed: parsePorcelainZ(status), root };
}

/**
 * Drop the changes this wizard made itself (a re-run must not be blocked by the previous run): a
 * changed path is dropped when the manifest in `packageDir` records it with an `afterSha256` that
 * still matches the file. Entries without a content hash (manual steps, env markers) never excuse a
 * change, and neither does a file the user edited after the wizard.
 */
export async function withoutWizardChanges(state: GitState, packageDir: string): Promise<GitState> {
  if (!state.repo || state.root === undefined || state.changed.length === 0) return state;
  const manifest = await loadManifest(packageDir);
  if (manifest === null) return state;
  // git reports real paths; compare against the real package directory
  const base = await realpath(packageDir);
  const expected = new Map<string, string>();
  for (const e of manifest.entries) {
    if (e.afterSha256 !== undefined) expected.set(resolve(base, e.file), e.afterSha256);
  }
  const root = state.root;
  const kept: string[] = [];
  for (const rel of state.changed) {
    const abs = resolve(root, rel);
    const want = expected.get(abs);
    if (want === undefined || (await hashOf(abs)) !== want) kept.push(rel);
  }
  return { ...state, changed: kept };
}

async function hashOf(path: string): Promise<string | null> {
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch {
    return null;
  }
}

export type GitCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: 'not-a-git-repo' | 'dirty-git-tree'; message: string };

function listFiles(files: readonly string[]): string {
  const shown = files.slice(0, SHOWN_FILES).map((f) => `  ${f}`);
  const more = files.length - SHOWN_FILES;
  return [...shown, ...(more > 0 ? [`  …and ${more} more`] : [])].join('\n');
}

/**
 * The version-control precondition: the wizard edits files, so a clean git tree is the user's undo.
 * `--ignore-git-changes` proceeds; otherwise interactive runs ask and non-interactive runs fail.
 */
export async function checkGit(
  state: GitState,
  opts: { readonly nonInteractive: boolean; readonly ignoreGitChanges: boolean },
  ui: { readonly confirm: (message: string) => Promise<boolean>; readonly log: Logger },
): Promise<GitCheck> {
  if (!state.repo) {
    if (opts.ignoreGitChanges) {
      ui.log.warn('Not under version control: continuing because of --ignore-git-changes.');
      return { ok: true };
    }
    if (opts.nonInteractive) {
      return {
        ok: false,
        error: 'not-a-git-repo',
        message:
          'This project is not under version control (git), so its changes could not be reviewed or undone. Pass --ignore-git-changes to continue anyway.',
      };
    }
    if (
      !(await ui.confirm('This project is not a git repository. Continue without version control?'))
    ) {
      throw new CancelledError();
    }
    return { ok: true };
  }
  if (state.changed.length === 0) return { ok: true };
  if (opts.ignoreGitChanges) {
    ui.log.warn(
      'The git tree has uncommitted changes: continuing because of --ignore-git-changes.',
    );
    return { ok: true };
  }
  const list = listFiles(state.changed);
  if (opts.nonInteractive) {
    return {
      ok: false,
      error: 'dirty-git-tree',
      message: `The git working tree has uncommitted changes:\n${list}\nCommit or stash them, or pass --ignore-git-changes.`,
    };
  }
  if (
    !(await ui.confirm(`The git working tree has uncommitted changes:\n${list}\nContinue anyway?`))
  ) {
    throw new CancelledError();
  }
  return { ok: true };
}

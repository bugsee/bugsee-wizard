import type { Logger } from '../core/logger.js';
import { runChildOutput } from '../core/run-child.js';
import { CancelledError } from '../engine/noninteractive.js';

export interface GitState {
  /** Inside a git working tree. */
  readonly repo: boolean;
  /** Paths `git status` reports as changed or untracked (repo-relative). */
  readonly changed: readonly string[];
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
  const status = await run('git', ['status', '--porcelain=v1', '-z'], { cwd: dir });
  return { repo: true, changed: parsePorcelainZ(status) };
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

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CancelledError } from '../../src/engine/noninteractive.js';
import { checkGit, parsePorcelainZ, probeGit } from '../../src/web/preconditions.js';

const sink = () => {
  const lines: string[] = [];
  const push = (m: string): void => {
    lines.push(m);
  };
  return {
    lines,
    log: { info: push, warn: push, error: push, success: push, step: push, debug: push },
  };
};

describe('parsePorcelainZ', () => {
  it('lists every changed path, skipping the original name of a rename or copy', () => {
    const out = ' M src/a.ts\0?? new file.txt\0R  b.ts\0old-b.ts\0C  c.ts\0orig-c.ts\0D  gone.ts\0';
    expect(parsePorcelainZ(out)).toEqual(['src/a.ts', 'new file.txt', 'b.ts', 'c.ts', 'gone.ts']);
  });
  it('a rename in the worktree column also carries an original name', () => {
    expect(parsePorcelainZ(' R x.ts\0y.ts\0')).toEqual(['x.ts']);
  });
  it('is empty for a clean tree', () => {
    expect(parsePorcelainZ('')).toEqual([]);
  });
  it('ignores a field too short to carry a path', () => {
    expect(parsePorcelainZ('M \0 M a.ts\0')).toEqual(['a.ts']);
  });
});

describe('probeGit', () => {
  it('asks git through the shared child runner (no shell) and parses the status', async () => {
    const run = vi.fn(async (_cmd: string, args: readonly string[], _o: { cwd: string }) =>
      args[0] === 'rev-parse' ? 'true\n' : ' M a.ts\0',
    );
    await expect(probeGit('/repo', run)).resolves.toEqual({ repo: true, changed: ['a.ts'] });
    expect(run.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ['git', ['rev-parse', '--is-inside-work-tree'], { cwd: '/repo' }],
      ['git', ['status', '--porcelain=v1', '-z'], { cwd: '/repo' }],
    ]);
  });
  it('not a repository when rev-parse fails (or git is missing)', async () => {
    const run = vi.fn(async () => {
      throw new Error('fatal: not a git repository');
    });
    await expect(probeGit('/x', run)).resolves.toEqual({ repo: false, changed: [] });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('not a repository when rev-parse answers anything but "true" (inside .git)', async () => {
    const run = vi.fn(async () => 'false\n');
    await expect(probeGit('/x/.git', run)).resolves.toEqual({ repo: false, changed: [] });
  });

  describe.skipIf(process.platform === 'win32')('against a real git', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'bugsee-git-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    it('a plain directory is not a repository', async () => {
      await expect(probeGit(dir)).resolves.toEqual({ repo: false, changed: [] });
    });
    it('reports untracked files in a fresh repository', async () => {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      await writeFile(join(dir, 'a b.txt'), 'x');
      await expect(probeGit(dir)).resolves.toEqual({ repo: true, changed: ['a b.txt'] });
    });
  });
});

describe('checkGit', () => {
  const confirmNo = vi.fn(async (_m: string) => false);
  const confirmYes = vi.fn(async (_m: string) => true);
  beforeEach(() => {
    vi.clearAllMocks();
  });
  const base = { nonInteractive: false, ignoreGitChanges: false };

  it('a clean repository passes without asking', async () => {
    const { log } = sink();
    await expect(
      checkGit({ repo: true, changed: [] }, base, { confirm: confirmNo, log }),
    ).resolves.toEqual({ ok: true });
    expect(confirmNo).not.toHaveBeenCalled();
  });

  describe('not a repository', () => {
    const state = { repo: false, changed: [] };
    it('non-interactive fails without --ignore-git-changes', async () => {
      const { log } = sink();
      const r = await checkGit(
        state,
        { ...base, nonInteractive: true },
        { confirm: confirmYes, log },
      );
      expect(r).toMatchObject({ ok: false, error: 'not-a-git-repo' });
      if (r.ok) throw new Error('expected failure');
      expect(r.message).toContain('--ignore-git-changes');
      expect(confirmYes).not.toHaveBeenCalled();
    });
    it('--ignore-git-changes continues (with a warning) and never asks', async () => {
      const { lines, log } = sink();
      const r = await checkGit(
        state,
        { nonInteractive: true, ignoreGitChanges: true },
        { confirm: confirmNo, log },
      );
      expect(r).toEqual({ ok: true });
      expect(confirmNo).not.toHaveBeenCalled();
      expect(lines.join('\n')).toMatch(/version control/);
    });
    it('interactive asks to continue without version control', async () => {
      const { log } = sink();
      await expect(checkGit(state, base, { confirm: confirmYes, log })).resolves.toEqual({
        ok: true,
      });
      expect(String(confirmYes.mock.calls[0]?.[0])).toMatch(/without version control/);
    });
    it('interactive "no" cancels', async () => {
      const { log } = sink();
      await expect(checkGit(state, base, { confirm: confirmNo, log })).rejects.toBeInstanceOf(
        CancelledError,
      );
    });
  });

  describe('dirty tree', () => {
    const files = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
    const state = { repo: true, changed: files };
    it('non-interactive fails without --ignore-git-changes and names the files', async () => {
      const { log } = sink();
      const r = await checkGit(
        state,
        { ...base, nonInteractive: true },
        { confirm: confirmYes, log },
      );
      expect(r).toMatchObject({ ok: false, error: 'dirty-git-tree' });
      if (r.ok) throw new Error('expected failure');
      expect(r.message).toContain('f0.ts');
      expect(r.message).toContain('--ignore-git-changes');
    });
    it('--ignore-git-changes continues without asking', async () => {
      const { log } = sink();
      await expect(
        checkGit(state, { ...base, ignoreGitChanges: true }, { confirm: confirmNo, log }),
      ).resolves.toEqual({ ok: true });
      expect(confirmNo).not.toHaveBeenCalled();
    });
    it('interactive lists at most 10 files and how many more', async () => {
      const { log } = sink();
      await checkGit(state, base, { confirm: confirmYes, log });
      const msg = String(confirmYes.mock.calls[0]?.[0]);
      expect(msg).toContain('f9.ts');
      expect(msg).not.toContain('f10.ts');
      expect(msg).toContain('2 more');
    });
    it('interactive "no" cancels', async () => {
      const { log } = sink();
      await expect(checkGit(state, base, { confirm: confirmNo, log })).rejects.toBeInstanceOf(
        CancelledError,
      );
    });
  });
});

import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordEntry } from '../../src/engine/manifest.js';
import { CancelledError, exitCodeFor, MissingInputError } from '../../src/engine/noninteractive.js';
import { runJavaScriptInstall } from '../../src/web/run.js';
import { runJavaScriptUninstall } from '../../src/web/uninstall.js';
import { baseOpts, captureOutput, makeDeps, type Sandbox, sandbox, tree } from './run-helpers.js';

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

describe.skipIf(process.platform === 'win32')('runJavaScriptUninstall', () => {
  let sb: Sandbox;
  let original: Record<string, string>;
  beforeEach(async () => {
    sb = await sandbox('vite-react-spa');
    original = await tree(sb.project);
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  const install = async (): Promise<void> => {
    const r = await runJavaScriptInstall(baseOpts(sb.project), makeDeps(captureOutput()));
    expect(r.ok).toBe(true);
  };

  it('restores the original tree byte for byte (on a copy of the fixture)', async () => {
    await install();
    expect(await tree(sb.project)).not.toEqual(original);
    const cap = captureOutput();
    const r = await runJavaScriptUninstall(baseOpts(sb.project, { yes: true }), makeDeps(cap));
    expect(r.ok).toBe(true);
    expect(r.incomplete).toBe(false);
    expect(r.steps).toEqual([
      { id: 'package.json', outcome: 'reverted' },
      { id: 'package-lock.json', outcome: 'reverted' },
      { id: 'vite.config.ts', outcome: 'reverted' },
      { id: '.gitignore', outcome: 'deleted' },
      { id: '.env.bugsee-build-plugin', outcome: 'deleted' },
    ]);
    expect(await tree(sb.project)).toEqual(original);
    expect(exitCodeFor(r, true)).toBe(0);
  });

  it('always prints the list of files it will change first', async () => {
    await install();
    const cap = captureOutput();
    await runJavaScriptUninstall(baseOpts(sb.project, { yes: true }), makeDeps(cap));
    const list = cap.lines.find((l) => l.includes('will change'));
    expect(list).toBeDefined();
    for (const f of ['package.json', 'vite.config.ts', '.env.bugsee-build-plugin', '.gitignore']) {
      expect(list).toContain(f);
    }
    expect(cap.lines.indexOf(list ?? '')).toBe(0);
  });

  it('non-interactive without --yes is MissingInputError(confirmation) and changes nothing', async () => {
    await install();
    const installed = await tree(sb.project);
    const cap = captureOutput();
    await expect(runJavaScriptUninstall(baseOpts(sb.project), makeDeps(cap))).rejects.toEqual(
      new MissingInputError('confirmation'),
    );
    expect(await tree(sb.project)).toEqual(installed);
    expect(cap.lines.join('\n')).toContain('vite.config.ts');
  });

  it('interactive asks; "no" cancels and changes nothing', async () => {
    await install();
    const installed = await tree(sb.project);
    const confirm = vi.fn(async () => false);
    await expect(
      runJavaScriptUninstall(
        baseOpts(sb.project, { nonInteractive: false }),
        makeDeps(captureOutput(), { prompts: { confirm, select: vi.fn() } }),
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await tree(sb.project)).toEqual(installed);
  });

  it('interactive "yes" removes', async () => {
    await install();
    const confirm = vi.fn(async () => true);
    const r = await runJavaScriptUninstall(
      baseOpts(sb.project, { nonInteractive: false }),
      makeDeps(captureOutput(), { prompts: { confirm, select: vi.fn() } }),
    );
    expect(r.ok).toBe(true);
    expect(await tree(sb.project)).toEqual(original);
  });

  it('--dry-run lists without asking and changes nothing', async () => {
    await install();
    const installed = await tree(sb.project);
    const confirm = vi.fn(async () => false);
    const r = await runJavaScriptUninstall(
      baseOpts(sb.project, { dryRun: true }),
      makeDeps(captureOutput(), { prompts: { confirm, select: vi.fn() } }),
    );
    expect(r.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(await tree(sb.project)).toEqual(installed);
  });

  it('no manifest: nothing to uninstall, exit 0', async () => {
    const cap = captureOutput();
    const r = await runJavaScriptUninstall(baseOpts(sb.project, { yes: true }), makeDeps(cap));
    expect(r).toEqual({ ok: true, incomplete: false, steps: [] });
    expect(cap.lines.join('\n')).toMatch(/nothing to uninstall/i);
    expect(exitCodeFor(r, true)).toBe(0);
  });

  it('an invalid manifest is a failure, not "nothing to do"', async () => {
    await mkdir(join(sb.project, '.bugsee'));
    await writeFile(join(sb.project, '.bugsee/wizard-manifest.json'), '{"schema": 99}');
    const cap = captureOutput();
    const r = await runJavaScriptUninstall(baseOpts(sb.project, { yes: true }), makeDeps(cap));
    expect(r).toMatchObject({ ok: false, error: 'invalid-manifest' });
    expect(r.message).toContain('.bugsee/wizard-manifest.json');
    expect(exitCodeFor(r, true)).toBe(1);
  });

  it('a file the user added a line to keeps that line; only the wizard lines are removed', async () => {
    await install();
    await appendFile(join(sb.project, 'vite.config.ts'), '// my edit\n');
    const cap = captureOutput();
    const r = await runJavaScriptUninstall(baseOpts(sb.project, { yes: true }), makeDeps(cap));
    expect(r.ok).toBe(true);
    expect(r.steps.find((s) => s.id === 'vite.config.ts')?.outcome).toBe('reverted');
    const now = await readFile(join(sb.project, 'vite.config.ts'), 'utf8');
    expect(now).toContain('// my edit');
    expect(now).not.toContain('bugsee');
  });

  it('a wizard line the user rewrote is left and named: manual, incomplete, exit 3', async () => {
    await install();
    const cfg = join(sb.project, 'vite.config.ts');
    const src = await readFile(cfg, 'utf8');
    await writeFile(cfg, src.replace('// bugsee-wizard', '// bugsee-wizard (mine)'));
    const cap = captureOutput();
    const r = await runJavaScriptUninstall(baseOpts(sb.project, { yes: true }), makeDeps(cap));
    expect(r.ok).toBe(true);
    expect(r.incomplete).toBe(true);
    expect(r.steps.find((s) => s.id === 'vite.config.ts')?.outcome).toBe('manual');
    expect(cap.lines.join('\n')).toMatch(
      /vite\.config\.ts: reverted what it could; by hand: .*import/,
    );
    expect(exitCodeFor(r, true)).toBe(3);
  });

  it('a rollback error fails the run', async () => {
    await install();
    const r = await runJavaScriptUninstall(
      baseOpts(sb.project, { yes: true }),
      makeDeps(captureOutput(), {
        rollback: async () => ({ results: [{ file: 'x', outcome: 'skipped' }], failed: true }),
      }),
    );
    expect(r).toMatchObject({ ok: false, error: 'rollback-failed' });
  });

  it('no project: fails', async () => {
    const r = await runJavaScriptUninstall(
      baseOpts(join(sb.root, 'bin'), { yes: true }),
      makeDeps(captureOutput()),
    );
    expect(r).toMatchObject({ ok: false, error: 'no-project' });
  });
});

describe.skipIf(process.platform === 'win32')('uninstall from a workspace root', () => {
  let sb: Sandbox;
  afterEach(async () => {
    await sb.cleanup();
  });

  /** A wizard manifest in `pkg` that created `bugsee.txt` (and the file itself). */
  const installedIn = async (pkg: string): Promise<void> => {
    await writeFile(join(pkg, 'bugsee.txt'), 'hi\n');
    await recordEntry(
      pkg,
      { file: 'bugsee.txt', action: 'created', after: 'hi\n' },
      { wizard: '0.0.0', recipes: [] },
      { ignoreInGit: false },
    );
  };
  const web = () => join(sb.project, 'apps', 'web');
  const api = () => join(sb.project, 'apps', 'api');

  it('tooling root: finds the one package with a manifest and removes from it', async () => {
    sb = await sandbox('pnpm-monorepo');
    await installedIn(web());
    const cap = captureOutput();
    // the choice is reported at a visible level, not only in --debug
    const output = { ...cap.output, log: { ...cap.output.log, debug: () => undefined } };
    const r = await runJavaScriptUninstall(
      baseOpts(sb.project, { yes: true }),
      makeDeps(cap, { output }),
    );
    expect(r).toMatchObject({ ok: true, steps: [{ id: 'bugsee.txt', outcome: 'deleted' }] });
    expect(await exists(join(web(), 'bugsee.txt'))).toBe(false);
    expect(cap.lines.join('\n')).toContain('apps/web');
  });

  it('app-like root without its own manifest: also looks in the packages', async () => {
    sb = await sandbox('pnpm-monorepo');
    const pkgPath = join(sb.project, 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    pkg.dependencies = { react: '^18.3.1' };
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    await installedIn(web());
    const r = await runJavaScriptUninstall(
      baseOpts(sb.project, { yes: true }),
      makeDeps(captureOutput()),
    );
    expect(r.steps).toEqual([{ id: 'bugsee.txt', outcome: 'deleted' }]);
  });

  it('several packages with a manifest: non-interactive needs --package', async () => {
    sb = await sandbox('pnpm-monorepo');
    await installedIn(web());
    await installedIn(api());
    await expect(
      runJavaScriptUninstall(baseOpts(sb.project, { yes: true }), makeDeps(captureOutput())),
    ).rejects.toEqual(new MissingInputError('package'));
    const r = await runJavaScriptUninstall(
      baseOpts(sb.project, { yes: true, package: 'apps/api' }),
      makeDeps(captureOutput()),
    );
    expect(r.steps).toEqual([{ id: 'bugsee.txt', outcome: 'deleted' }]);
    expect(await exists(join(web(), 'bugsee.txt'))).toBe(true);
  });

  it('several packages with a manifest: interactive asks among those only', async () => {
    sb = await sandbox('pnpm-monorepo');
    await installedIn(web());
    await installedIn(api());
    const select = vi.fn(async (_m: string, o: readonly { value: string; label: string }[]) => {
      expect(o.map((x) => x.label).join(' ')).not.toContain('docs');
      expect(o).toHaveLength(2);
      return web();
    });
    const r = await runJavaScriptUninstall(
      baseOpts(sb.project, { yes: true, nonInteractive: false }),
      makeDeps(captureOutput(), { prompts: { confirm: vi.fn(async () => true), select } }),
    );
    expect(select).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(await exists(join(web(), 'bugsee.txt'))).toBe(false);
    expect(await exists(join(api(), 'bugsee.txt'))).toBe(true);
  });

  it('a manifest at the root itself wins over the packages', async () => {
    sb = await sandbox('pnpm-monorepo');
    await installedIn(sb.project);
    await installedIn(web());
    const r = await runJavaScriptUninstall(
      baseOpts(sb.project, { yes: true }),
      makeDeps(captureOutput()),
    );
    expect(r.steps).toEqual([{ id: 'bugsee.txt', outcome: 'deleted' }]);
    expect(await exists(join(sb.project, 'bugsee.txt'))).toBe(false);
    expect(await exists(join(web(), 'bugsee.txt'))).toBe(true);
  });

  it('no manifest anywhere: nothing to uninstall, no package question', async () => {
    sb = await sandbox('pnpm-monorepo');
    const cap = captureOutput();
    const r = await runJavaScriptUninstall(baseOpts(sb.project, { yes: true }), makeDeps(cap));
    expect(r).toEqual({ ok: true, incomplete: false, steps: [] });
    expect(cap.lines.join('\n')).toMatch(/nothing to uninstall/i);
  });
});

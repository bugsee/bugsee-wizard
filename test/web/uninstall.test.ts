import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CancelledError, exitCodeFor, MissingInputError } from '../../src/engine/noninteractive.js';
import { runJavaScriptInstall } from '../../src/web/run.js';
import { runJavaScriptUninstall } from '../../src/web/uninstall.js';
import { baseOpts, captureOutput, makeDeps, type Sandbox, sandbox, tree } from './run-helpers.js';

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
      { id: '.env.bugsee-build-plugin', outcome: 'deleted' },
      { id: '.gitignore', outcome: 'deleted' },
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

  it('a file changed since the install is left alone and makes the result incomplete', async () => {
    await install();
    await appendFile(join(sb.project, 'vite.config.ts'), '// my edit\n');
    const cap = captureOutput();
    const r = await runJavaScriptUninstall(baseOpts(sb.project, { yes: true }), makeDeps(cap));
    expect(r.ok).toBe(true);
    expect(r.incomplete).toBe(true);
    expect(r.steps.find((s) => s.id === 'vite.config.ts')?.outcome).toBe('manual');
    expect(await readFile(join(sb.project, 'vite.config.ts'), 'utf8')).toContain('// my edit');
    expect(cap.lines.join('\n')).toMatch(/vite\.config\.ts: changed since/);
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

import { access, appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadManifest } from '../../src/engine/manifest.js';
import { CancelledError, exitCodeFor, MissingInputError } from '../../src/engine/noninteractive.js';
import { parseRecipe } from '../../src/engine/recipe.js';
import { RecipeStoreError } from '../../src/engine/recipe-store.js';
import { WIZARD_VERSION } from '../../src/engine/telemetry.js';
import { probeGit } from '../../src/web/preconditions.js';
import { runJavaScriptInstall } from '../../src/web/run.js';
import { resolveSdkVersion } from '../../src/web/sdk-version.js';
import { SDK_FALLBACK_VERSION, SDK_TAG } from '../../src/web/versions.js';
import {
  baseOpts,
  captureOutput,
  gitCommitAll,
  makeDeps,
  type Sandbox,
  sandbox,
  TOKEN,
  tree,
  VITE_RECIPE,
} from './run-helpers.js';

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

describe.skipIf(process.platform === 'win32')('runJavaScriptInstall', () => {
  let sb: Sandbox;
  afterEach(async () => {
    await sb.cleanup();
  });

  describe('vite-react-spa end to end', () => {
    beforeEach(async () => {
      sb = await sandbox('vite-react-spa');
    });

    it('installs, edits, writes the env var and the manifest', async () => {
      const cap = captureOutput();
      const deps = makeDeps(cap);
      const r = await runJavaScriptInstall(baseOpts(sb.project), deps);
      expect(r).toEqual({
        ok: true,
        incomplete: false,
        steps: [
          { id: 'install-package:@bugsee/vite-plugin', outcome: 'applied' },
          { id: 'add-bundler-plugin:vite', outcome: 'applied' },
          { id: 'write-env-var:.env.bugsee-build-plugin:BUGSEE_APP_TOKEN', outcome: 'applied' },
          { id: 'ensure-gitignore:.env.bugsee-build-plugin', outcome: 'applied' },
          { id: 'ensure-gitignore:.bugsee/', outcome: 'applied' },
        ],
      });
      expect(await sb.npmCalls()).toEqual([
        {
          args: ['install', '-D', '@bugsee/vite-plugin@beta'],
          cwd: expect.stringMatching(/project$/),
        },
      ]);
      const pkg = JSON.parse(await readFile(join(sb.project, 'package.json'), 'utf8'));
      expect(pkg.devDependencies['@bugsee/vite-plugin']).toBeDefined();
      expect(await readFile(join(sb.project, 'vite.config.ts'), 'utf8')).toContain(
        "from '@bugsee/vite-plugin'",
      );
      expect(await readFile(join(sb.project, '.env.bugsee-build-plugin'), 'utf8')).toContain(
        `BUGSEE_APP_TOKEN=${TOKEN}`,
      );
      const gitignore = await readFile(join(sb.project, '.gitignore'), 'utf8');
      expect(gitignore).toContain('.env.bugsee-build-plugin');
      expect(gitignore).toContain('.bugsee/');
      const manifest = await loadManifest(sb.project);
      expect(manifest?.wizard).toBe(WIZARD_VERSION);
      expect(manifest?.recipes).toEqual([{ id: 'javascript-vite', revision: 'r1' }]);
      expect(manifest?.entries.map((e) => [e.file, e.action])).toEqual([
        ['package.json', 'edited'],
        ['package-lock.json', 'edited'],
        ['vite.config.ts', 'edited'],
        ['.env.bugsee-build-plugin', 'created'],
        ['.gitignore', 'created'],
      ]);
      // the recipe is resolved for the build tool, the resolved SDK version and this wizard
      expect(deps.resolveRecipe).toHaveBeenCalledWith({
        platform: 'javascript-vite',
        sdkVersion: '0.1.0-beta.5',
        engine: WIZARD_VERSION,
      });
      expect(exitCodeFor(r, true)).toBe(0);
    });

    it('prints the plan and an outro explaining how to verify', async () => {
      const cap = captureOutput();
      await runJavaScriptInstall(baseOpts(sb.project), makeDeps(cap));
      const text = cap.lines.join('\n');
      expect(text).toContain('Install @bugsee/vite-plugin@beta');
      expect(text).toContain('Add the Bugsee plugin to the vite config');
      expect(text).toMatch(/production/i);
      expect(text).toMatch(/npm run build/);
      expect(text).toMatch(/upload/i);
    });

    it('a second run changes nothing and reports every step as already done (exit 0)', async () => {
      await runJavaScriptInstall(baseOpts(sb.project), makeDeps(captureOutput()));
      const after = await tree(sb.project);
      const r = await runJavaScriptInstall(baseOpts(sb.project), makeDeps(captureOutput()));
      expect(r.ok).toBe(true);
      expect(r.incomplete).toBe(false);
      expect(r.steps.map((s) => s.outcome)).toEqual([
        'skipped',
        'skipped',
        'skipped',
        'skipped',
        'skipped',
      ]);
      expect(await tree(sb.project)).toEqual(after);
      expect(await sb.npmCalls()).toHaveLength(1);
      expect(exitCodeFor(r, true)).toBe(0);
    });

    it('--dry-run writes nothing at all', async () => {
      const before = await tree(sb.project);
      const cap = captureOutput();
      const r = await runJavaScriptInstall(baseOpts(sb.project, { dryRun: true }), makeDeps(cap));
      expect(r.ok).toBe(true);
      expect(await tree(sb.project)).toEqual(before);
      expect(await sb.npmCalls()).toEqual([]);
      expect(cap.lines.join('\n')).toMatch(/dry run/i);
    });

    it('the token never reaches the log, stdout, stderr or the result', async () => {
      const writes: string[] = [];
      const out = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
        writes.push(String(c));
        return true;
      });
      const err = vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
        writes.push(String(c));
        return true;
      });
      try {
        const cap = captureOutput();
        const r = await runJavaScriptInstall(baseOpts(sb.project, { debug: true }), makeDeps(cap));
        expect(JSON.stringify(r)).not.toContain(TOKEN);
        expect(cap.lines.join('\n')).not.toContain(TOKEN);
        expect(writes.join('')).not.toContain(TOKEN);
        expect(
          await readFile(join(sb.project, '.bugsee/wizard-manifest.json'), 'utf8'),
        ).not.toContain(TOKEN);
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
    });

    it('--package naming the project itself is accepted; any other directory is not', async () => {
      const ok = await runJavaScriptInstall(
        baseOpts(sb.project, { package: '.', dryRun: true }),
        makeDeps(captureOutput()),
      );
      expect(ok.ok).toBe(true);
      const bad = await runJavaScriptInstall(
        baseOpts(sb.project, { package: '..', dryRun: true }),
        makeDeps(captureOutput()),
      );
      expect(bad).toMatchObject({ ok: false, error: 'package-not-found' });
    });

    it('takes the token from --token over BUGSEE_APP_TOKEN', async () => {
      await runJavaScriptInstall(
        baseOpts(sb.project, { token: 'tok_FLAG_1' }),
        makeDeps(captureOutput()),
      );
      expect(await readFile(join(sb.project, '.env.bugsee-build-plugin'), 'utf8')).toContain(
        'BUGSEE_APP_TOKEN=tok_FLAG_1',
      );
    });

    it('a missing token in non-interactive mode is MissingInputError(token), nothing written', async () => {
      const before = await tree(sb.project);
      await expect(
        runJavaScriptInstall(baseOpts(sb.project), makeDeps(captureOutput(), { env: {} })),
      ).rejects.toEqual(new MissingInputError('token'));
      expect(await tree(sb.project)).toEqual(before);
    });

    it('a dirty git tree blocks a non-interactive run without --ignore-git-changes', async () => {
      const before = await tree(sb.project);
      const git = vi.fn(async () => ({ repo: true, changed: ['src/x.ts'] }));
      const r = await runJavaScriptInstall(
        baseOpts(sb.project),
        makeDeps(captureOutput(), { git }),
      );
      expect(r).toMatchObject({ ok: false, error: 'dirty-git-tree' });
      expect(r.message).toContain('src/x.ts');
      expect(exitCodeFor(r, true)).toBe(1);
      expect(await tree(sb.project)).toEqual(before);
      expect(git).toHaveBeenCalledWith(sb.project);
    });

    it('--ignore-git-changes proceeds over a dirty tree', async () => {
      const git = vi.fn(async () => ({ repo: true, changed: ['src/x.ts'] }));
      const r = await runJavaScriptInstall(
        baseOpts(sb.project, { ignoreGitChanges: true }),
        makeDeps(captureOutput(), { git }),
      );
      expect(r.ok).toBe(true);
    });

    it('--ignore-git-changes never runs the git probe (a failing git cannot stop the run)', async () => {
      const git = vi.fn(async () => {
        throw new Error('git status: output too large');
      });
      const r = await runJavaScriptInstall(
        baseOpts(sb.project, { ignoreGitChanges: true }),
        makeDeps(captureOutput(), { git }),
      );
      expect(r.ok).toBe(true);
      expect(git).not.toHaveBeenCalled();
    });

    it('--dry-run needs no token and the placeholder is never printed', async () => {
      const before = await tree(sb.project);
      const cap = captureOutput();
      const r = await runJavaScriptInstall(
        baseOpts(sb.project, { dryRun: true }),
        makeDeps(cap, { env: {} }),
      );
      expect(r.ok).toBe(true);
      expect(r.steps.map((s) => s.id)).toContain(
        'write-env-var:.env.bugsee-build-plugin:BUGSEE_APP_TOKEN',
      );
      expect(await tree(sb.project)).toEqual(before);
      expect(cap.lines.join('\n')).not.toMatch(/placeholder/i);
    });

    it('--dry-run with a token available uses it (an existing env var is reported as done)', async () => {
      await runJavaScriptInstall(baseOpts(sb.project), makeDeps(captureOutput()));
      const r = await runJavaScriptInstall(
        baseOpts(sb.project, { dryRun: true }),
        makeDeps(captureOutput()),
      );
      expect(r.steps.find((s) => s.id.startsWith('write-env-var'))?.outcome).toBe('skipped');
    });

    it('--dry-run on a clean repository adds no git note', async () => {
      const cap = captureOutput();
      await runJavaScriptInstall(
        baseOpts(sb.project, { dryRun: true }),
        makeDeps(cap, { git: async () => ({ repo: true, changed: [], root: sb.project }) }),
      );
      expect(cap.lines.join('\n')).not.toMatch(/uncommitted|version control/);
    });

    it('--dry-run is not stopped by a dirty tree or a missing repository (only a note)', async () => {
      for (const state of [
        { repo: true, changed: ['src/dirty.ts'], root: sb.project },
        { repo: false, changed: [] },
      ]) {
        const cap = captureOutput();
        const confirm = vi.fn(async () => false);
        const r = await runJavaScriptInstall(
          baseOpts(sb.project, { dryRun: true, nonInteractive: false }),
          makeDeps(cap, { git: async () => state, prompts: { confirm, select: vi.fn() } }),
        );
        expect(r.ok).toBe(true);
        expect(confirm).not.toHaveBeenCalled();
        if (state.repo) expect(cap.lines.join('\n')).toContain('src/dirty.ts');
        else expect(cap.lines.join('\n')).toMatch(/version control/);
      }
    });

    it('not a git repository fails non-interactively, asks interactively', async () => {
      const git = vi.fn(async () => ({ repo: false, changed: [] }));
      const r = await runJavaScriptInstall(
        baseOpts(sb.project),
        makeDeps(captureOutput(), { git }),
      );
      expect(r).toMatchObject({ ok: false, error: 'not-a-git-repo' });
      const confirm = vi.fn(async (_m: string) => false);
      await expect(
        runJavaScriptInstall(
          baseOpts(sb.project, { nonInteractive: false }),
          makeDeps(captureOutput(), { git, prompts: { confirm, select: vi.fn() } }),
        ),
      ).rejects.toBeInstanceOf(CancelledError);
      expect(String(confirm.mock.calls[0]?.[0])).toMatch(/version control/);
    });

    it('interactive: asks for consent after the plan; "no" cancels before anything is written', async () => {
      const before = await tree(sb.project);
      const confirm = vi.fn(async () => false);
      await expect(
        runJavaScriptInstall(
          baseOpts(sb.project, { nonInteractive: false }),
          makeDeps(captureOutput(), { prompts: { confirm, select: vi.fn() } }),
        ),
      ).rejects.toBeInstanceOf(CancelledError);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(await tree(sb.project)).toEqual(before);
    });

    it('interactive: --yes and --dry-run skip the consent prompt', async () => {
      const confirm = vi.fn(async () => false);
      const prompts = { confirm, select: vi.fn() };
      await runJavaScriptInstall(
        baseOpts(sb.project, { nonInteractive: false, dryRun: true }),
        makeDeps(captureOutput(), { prompts }),
      );
      const r = await runJavaScriptInstall(
        baseOpts(sb.project, { nonInteractive: false, yes: true }),
        makeDeps(captureOutput(), { prompts }),
      );
      expect(confirm).not.toHaveBeenCalled();
      expect(r.ok).toBe(true);
    });

    it('non-interactive never asks for consent', async () => {
      const confirm = vi.fn(async () => false);
      const r = await runJavaScriptInstall(
        baseOpts(sb.project),
        makeDeps(captureOutput(), { prompts: { confirm, select: vi.fn() } }),
      );
      expect(confirm).not.toHaveBeenCalled();
      expect(r.ok).toBe(true);
    });

    it('Review Focus 2: an unusual vite config is incomplete with a snippet; that file is untouched', async () => {
      const config =
        "import { defineConfig } from 'vite';\nimport base from './base.config';\nexport default defineConfig(base);\n";
      await writeFile(join(sb.project, 'vite.config.ts'), config);
      const cap = captureOutput();
      const r = await runJavaScriptInstall(baseOpts(sb.project), makeDeps(cap));
      expect(r.ok).toBe(true);
      expect(r.incomplete).toBe(true);
      expect(r.steps.find((s) => s.id === 'add-bundler-plugin:vite')?.outcome).toBe('manual');
      expect(r.snippets).toEqual([
        {
          file: 'vite.config.ts',
          title: 'Add the Bugsee plugin to vite.config.ts',
          code: expect.stringContaining('bugsee()'),
        },
      ]);
      expect(cap.lines.join('\n')).toContain('bugsee()');
      expect(await readFile(join(sb.project, 'vite.config.ts'), 'utf8')).toBe(config);
      expect(exitCodeFor(r, true)).toBe(3);
      expect(exitCodeFor(r, false)).toBe(0);
      const manifest = await loadManifest(sb.project);
      expect(manifest?.entries.find((e) => e.file === 'vite.config.ts')?.action).toBe('manual');
    });

    it('no package manager: the install is blocked, the run fails and leaves no manifest', async () => {
      const r = await runJavaScriptInstall(
        baseOpts(sb.project),
        makeDeps(captureOutput(), { detectPackageManager: async () => null }),
      );
      expect(r.ok).toBe(false);
      expect(r.steps[0]).toEqual({ id: 'install-package:@bugsee/vite-plugin', outcome: 'blocked' });
      expect(await exists(join(sb.project, '.bugsee'))).toBe(false);
      expect(exitCodeFor(r, true)).toBe(1);
    });

    it('a failing step rolls back what was applied and writes no manifest', async () => {
      const before = await tree(sb.project);
      await writeFile(join(sb.root, 'bin', 'npm'), '#!/bin/sh\necho boom >&2\nexit 1\n');
      const r = await runJavaScriptInstall(baseOpts(sb.project), makeDeps(captureOutput()));
      expect(r).toMatchObject({ ok: false, error: 'step-failed' });
      expect(await tree(sb.project)).toEqual(before);
    });

    it('no recipe for the build tool: fails with the store message', async () => {
      const resolveRecipe = vi.fn(async () => {
        throw new RecipeStoreError(
          'No recipe for javascript-vite covers SDK version 0.1.0-beta.5.',
        );
      });
      const r = await runJavaScriptInstall(
        baseOpts(sb.project),
        makeDeps(captureOutput(), { resolveRecipe }),
      );
      expect(r).toMatchObject({ ok: false, error: 'recipe-unavailable' });
      expect(r.message).toContain('No recipe for javascript-vite');
    });

    it('logs a recipe warning (offline snapshot, nearest older recipe)', async () => {
      const cap = captureOutput();
      const resolveRecipe = vi.fn(async () => ({
        recipe: (await import('./run-helpers.js')).VITE_RECIPE,
        revision: 'r1',
        source: 'snapshot' as const,
        warning: 'Using the bundled offline recipe r1.',
      }));
      await runJavaScriptInstall(baseOpts(sb.project), makeDeps(cap, { resolveRecipe }));
      expect(cap.lines).toContain('Using the bundled offline recipe r1.');
    });

    it('an offline registry resolves recipes for the fallback SDK version', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
      const deps = makeDeps(captureOutput(), {
        resolveSdkVersion: (q) => resolveSdkVersion({ ...q, fetchImpl }),
      });
      await runJavaScriptInstall(baseOpts(sb.project), deps);
      expect(deps.resolveRecipe).toHaveBeenCalledWith(
        expect.objectContaining({ sdkVersion: SDK_FALLBACK_VERSION }),
      );
      expect(fetchImpl).toHaveBeenCalled();
    });

    it('asks for the SDK_TAG and passes --sdk-version as the override', async () => {
      const deps = makeDeps(captureOutput(), { resolveSdkVersion: vi.fn(async () => '0.2.0') });
      await runJavaScriptInstall(baseOpts(sb.project, { sdkVersion: '0.2.0' }), deps);
      expect(deps.resolveSdkVersion).toHaveBeenCalledWith(
        expect.objectContaining({ tag: SDK_TAG, override: '0.2.0' }),
      );
      expect(deps.resolveRecipe).toHaveBeenCalledWith(
        expect.objectContaining({ sdkVersion: '0.2.0' }),
      );
    });

    it('warns about an unreadable manifest it had to move aside', async () => {
      await mkdir(join(sb.project, '.bugsee'));
      await writeFile(join(sb.project, '.bugsee/wizard-manifest.json'), '{ not json');
      const cap = captureOutput();
      const r = await runJavaScriptInstall(baseOpts(sb.project), makeDeps(cap));
      expect(r.ok).toBe(true);
      const moved = (await readdir(join(sb.project, '.bugsee'))).find((f) => f.includes('.bad-'));
      expect(moved).toBeDefined();
      expect(cap.lines.join('\n')).toContain(`.bugsee/${moved}`);
    });

    it('logs supported-version warnings and continues', async () => {
      const pkgPath = join(sb.project, 'package.json');
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      pkg.devDependencies.vite = '^4.0.0';
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
      const cap = captureOutput();
      const r = await runJavaScriptInstall(baseOpts(sb.project), makeDeps(cap));
      expect(r.ok).toBe(true);
      expect(cap.lines.join('\n')).toMatch(/vite \^4\.0\.0 is older than the supported/);
    });

    it('notes when the project was found above the starting directory', async () => {
      await mkdir(join(sb.project, 'src'));
      // a stray lockfile in the starting directory must not pick the package manager
      await writeFile(join(sb.project, 'src', 'yarn.lock'), '');
      const cap = captureOutput();
      const r = await runJavaScriptInstall(baseOpts(join(sb.project, 'src')), makeDeps(cap));
      expect(r.ok).toBe(true);
      expect(cap.lines.join('\n')).toContain(`Using the project at ${sb.project}`);
      expect(await sb.npmCalls()).toHaveLength(1);
      // the package dir, not the starting directory, is what files are relative to
      const manifest = await loadManifest(sb.project);
      expect(manifest?.entries.map((e) => e.file)).toContain('vite.config.ts');
    });
  });

  describe('no project', () => {
    beforeEach(async () => {
      sb = await sandbox('non-js');
    });
    it('fails with a clear message', async () => {
      const r = await runJavaScriptInstall(baseOpts(sb.project), makeDeps(captureOutput()));
      expect(r).toMatchObject({ ok: false, error: 'no-project' });
      expect(r.message).toMatch(/no JavaScript project found/i);
    });
  });

  describe('monorepo root', () => {
    beforeEach(async () => {
      sb = await sandbox('pnpm-monorepo');
    });

    it('non-interactive without --package is MissingInputError(package)', async () => {
      await expect(
        runJavaScriptInstall(baseOpts(sb.project), makeDeps(captureOutput())),
      ).rejects.toEqual(new MissingInputError('package'));
    });

    it('rejects a --package that is not one of the workspace packages, listing them', async () => {
      const r = await runJavaScriptInstall(
        baseOpts(sb.project, { package: 'apps/nope' }),
        makeDeps(captureOutput()),
      );
      expect(r).toMatchObject({ ok: false, error: 'package-not-found' });
      expect(r.message).toContain('apps/web');
      expect(r.message).toContain('apps/api');
    });

    it('--package selects the package, re-detected there', async () => {
      const deps = makeDeps(captureOutput(), {
        // the pnpm fixture: no real pnpm here, so stop at the plan (dry run)
      });
      const r = await runJavaScriptInstall(
        baseOpts(sb.project, { package: 'apps/web', dryRun: true }),
        deps,
      );
      expect(r.ok).toBe(true);
      expect(deps.resolveRecipe).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'javascript-vite' }),
      );
      expect(deps.git).toHaveBeenCalledWith(join(sb.project, 'apps/web'));
    });

    it('interactive: asks which package', async () => {
      const select = vi.fn(async (_m: string, _o: readonly { value: string; label: string }[]) =>
        join(sb.project, 'apps/web'),
      );
      const deps = makeDeps(captureOutput(), {
        prompts: { confirm: vi.fn(async () => true), select },
      });
      const r = await runJavaScriptInstall(
        baseOpts(sb.project, { nonInteractive: false, dryRun: true }),
        deps,
      );
      expect(r.ok).toBe(true);
      const options = select.mock.calls[0]?.[1] ?? [];
      expect(options.map((o) => o.label)).toEqual(
        expect.arrayContaining([expect.stringContaining('apps/web')]),
      );
      expect(options).toHaveLength(3);
    });
  });
});

describe.skipIf(process.platform === 'win32')('re-runs against a real git repository', () => {
  let sb: Sandbox;
  afterEach(async () => {
    await sb.cleanup();
  });
  // the real probe, not an injected one
  const realGit = (cap = captureOutput()) => makeDeps(cap, { git: (d) => probeGit(d) });

  it('a second run is not blocked by the wizard own changes: all satisfied, exit 0', async () => {
    sb = await sandbox('vite-react-spa');
    gitCommitAll(sb.project);
    const first = await runJavaScriptInstall(baseOpts(sb.project), realGit());
    expect(first.ok).toBe(true);
    const after = await tree(sb.project);
    const second = await runJavaScriptInstall(baseOpts(sb.project), realGit());
    expect(second).toMatchObject({ ok: true, incomplete: false });
    expect(second.steps.every((s) => s.outcome === 'skipped')).toBe(true);
    expect(exitCodeFor(second, true)).toBe(0);
    expect(await tree(sb.project)).toEqual(after);
  });

  it('a wizard-touched file the user then edited still stops a non-interactive run', async () => {
    sb = await sandbox('vite-react-spa');
    gitCommitAll(sb.project);
    await runJavaScriptInstall(baseOpts(sb.project), realGit());
    await appendFile(join(sb.project, 'vite.config.ts'), '// mine\n');
    const r = await runJavaScriptInstall(baseOpts(sb.project), realGit());
    expect(r).toMatchObject({ ok: false, error: 'dirty-git-tree' });
    expect(r.message).toContain('vite.config.ts');
    expect(r.message).not.toContain('package.json');
  });

  it('works for a package in a subdirectory of the repository (status paths are repo-relative)', async () => {
    sb = await sandbox('vite-react-spa');
    const repo = join(sb.root, 'repo');
    await mkdir(join(repo, 'apps'), { recursive: true });
    await rename(sb.project, join(repo, 'apps', 'web'));
    gitCommitAll(repo);
    const pkg = join(repo, 'apps', 'web');
    expect((await runJavaScriptInstall(baseOpts(pkg), realGit())).ok).toBe(true);
    const second = await runJavaScriptInstall(baseOpts(pkg), realGit());
    expect(second.ok).toBe(true);
    expect(second.steps.every((s) => s.outcome === 'skipped')).toBe(true);
    await mkdir(sb.project); // for cleanup symmetry
  });

  it('a wizard-created file in a new directory does not block the re-run', async () => {
    sb = await sandbox('vite-react-spa');
    gitCommitAll(sb.project);
    const recipe = parseRecipe({
      ...VITE_RECIPE,
      ops: [
        ...VITE_RECIPE.ops,
        { op: 'write-file', path: 'bugsee/verify.ts', template: 'export {};\n' },
      ],
    });
    const deps = (): ReturnType<typeof realGit> =>
      makeDeps(captureOutput(), {
        git: (d) => probeGit(d),
        resolveRecipe: async () => ({ recipe, revision: 'r2', source: 'snapshot' as const }),
      });
    expect((await runJavaScriptInstall(baseOpts(sb.project), deps())).ok).toBe(true);
    const second = await runJavaScriptInstall(baseOpts(sb.project), deps());
    expect(second.ok).toBe(true);
    expect(second.steps.every((s) => s.outcome === 'skipped')).toBe(true);
  });

  it('without a manifest every uncommitted change stops the first run', async () => {
    sb = await sandbox('vite-react-spa');
    gitCommitAll(sb.project);
    await writeFile(join(sb.project, 'notes.txt'), 'x');
    const r = await runJavaScriptInstall(baseOpts(sb.project), realGit());
    expect(r).toMatchObject({ ok: false, error: 'dirty-git-tree' });
  });

  it('an unrelated uncommitted change still stops it', async () => {
    sb = await sandbox('vite-react-spa');
    gitCommitAll(sb.project);
    await runJavaScriptInstall(baseOpts(sb.project), realGit());
    await writeFile(join(sb.project, 'notes.txt'), 'x');
    const r = await runJavaScriptInstall(baseOpts(sb.project), realGit());
    expect(r).toMatchObject({ ok: false, error: 'dirty-git-tree' });
    expect(r.message).toContain('notes.txt');
  });
});

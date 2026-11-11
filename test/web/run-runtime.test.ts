import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRecipe } from '../../src/engine/recipe-store.js';
import { runJavaScriptInstall } from '../../src/web/run.js';
import { runJavaScriptUninstall } from '../../src/web/uninstall.js';
import {
  baseOpts,
  captureOutput,
  gitCommitAll,
  makeDeps,
  type Sandbox,
  sandbox,
  TOKEN,
  tree,
} from './run-helpers.js';

const offline: typeof fetch = async () => {
  throw new TypeError('offline');
};
const real = vi.fn(async (q: Parameters<typeof resolveRecipe>[0]) =>
  resolveRecipe({ ...q, baseUrl: 'http://127.0.0.1:9/', fetchImpl: offline }),
);

describe.skipIf(process.platform === 'win32')('runtime recipes through the run', () => {
  let sb: Sandbox;
  afterEach(async () => {
    real.mockClear();
    await sb.cleanup();
  });

  it('plans the entry edit by file and never shows the token', async () => {
    sb = await sandbox('tsc-node');
    const cap = captureOutput();
    await runJavaScriptInstall(baseOpts(sb.project), makeDeps(cap, { resolveRecipe: real }));
    const text = cap.lines.join('\n');
    expect(text).toContain('edits src/index.ts (found via convention)');
    expect(text).toContain('launch(process.env.BUGSEE_APP_TOKEN)');
    expect(text).toContain('Node does not load .env');
    expect(text).not.toContain(TOKEN);
  });

  it('a framework project skips the runtime recipe, says why, and still runs the build tool recipe', async () => {
    sb = await sandbox('nextjs-app');
    const cap = captureOutput();
    await runJavaScriptInstall(baseOpts(sb.project), makeDeps(cap, { resolveRecipe: real }));
    expect(cap.lines.join('\n')).toMatch(/Skipping SDK install and init: nextjs/);
    const platforms = real.mock.calls.map((c) => c[0].platform);
    expect(platforms).toEqual(['javascript-webpack']);
  });

  it('no entry file: the init is a manual step (incomplete), the rest applies', async () => {
    sb = await sandbox('tsc-node');
    await rm(join(sb.project, 'src'), { recursive: true });
    const cap = captureOutput();
    const r = await runJavaScriptInstall(
      baseOpts(sb.project),
      makeDeps(cap, { resolveRecipe: real }),
    );
    expect(r.ok).toBe(true);
    expect(r.incomplete).toBe(true);
    expect(r.steps.find((s) => s.id === 'add-sdk-init:node')?.outcome).toBe('manual');
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('dry run changes nothing and a missing recipe fails before any change', async () => {
    sb = await sandbox('tsc-node');
    const before = await tree(sb.project);
    await runJavaScriptInstall(
      baseOpts(sb.project, { dryRun: true }),
      makeDeps(captureOutput(), { resolveRecipe: real }),
    );
    expect(await tree(sb.project)).toEqual(before);
    gitCommitAll(sb.project);
    const committed = await tree(sb.project);
    const failing = vi.fn(async () => {
      const { RecipeStoreError } = await import('../../src/engine/recipe-store.js');
      throw new RecipeStoreError('nope');
    });
    const r = await runJavaScriptInstall(
      baseOpts(sb.project),
      makeDeps(captureOutput(), { resolveRecipe: failing }),
    );
    expect(r).toMatchObject({ ok: false, error: 'recipe-unavailable' });
    expect(await tree(sb.project)).toEqual(committed);
  });

  it('install then uninstall restores the tree', async () => {
    sb = await sandbox('tsc-node');
    const before = await tree(sb.project);
    await runJavaScriptInstall(
      baseOpts(sb.project),
      makeDeps(captureOutput(), { resolveRecipe: real }),
    );
    const un = await runJavaScriptUninstall(
      baseOpts(sb.project, { yes: true }),
      makeDeps(captureOutput()),
    );
    expect(un.ok).toBe(true);
    expect(await tree(sb.project)).toEqual(before);
  });
});

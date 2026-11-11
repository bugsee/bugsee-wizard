import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exitCodeFor } from '../../src/engine/noninteractive.js';
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
    expect(text).toContain('edits src/index.ts (found via scripts.start)');
    expect(text).toContain(`launch(process.env['BUGSEE_APP_TOKEN'])`);
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

  it('a skipped runtime is an unfinished step: incomplete, a structured step and a snippet, exit 3', async () => {
    sb = await sandbox('nextjs-app');
    const r = await runJavaScriptInstall(
      baseOpts(sb.project),
      makeDeps(captureOutput(), { resolveRecipe: real }),
    );
    expect(r.ok).toBe(true);
    expect(r.incomplete).toBe(true);
    expect(r.steps[0]).toEqual({ id: 'add-sdk-init', outcome: 'manual' });
    expect(r.snippets?.[0]).toMatchObject({ title: 'Initialise Bugsee in your app' });
    expect(r.snippets?.[0]?.code).toContain('nextjs');
    // a framework has its own adapter package and guide, not the plain umbrella's launch()
    expect(r.snippets?.[0]?.code).toMatch(
      /First install the SDK: npm install @bugsee\/nextjs@beta/,
    );
    expect(r.snippets?.[0]?.code).toContain('https://docs.bugsee.com/nextjs');
    expect(r.snippets?.[0]?.code).not.toContain("from '@bugsee/bugsee'");
    expect(r.snippets?.[0]?.code).not.toContain(TOKEN);
    expect(exitCodeFor(r, true)).toBe(3);
  });

  it('the skip alone makes the run incomplete (a library, everything else finishes)', async () => {
    sb = await sandbox('tsc-node');
    const file = join(sb.project, 'package.json');
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    const { start: _start, ...scripts } = pkg.scripts;
    await writeFile(file, JSON.stringify({ ...pkg, scripts, main: 'lib/index.js' }));
    const r = await runJavaScriptInstall(
      baseOpts(sb.project),
      makeDeps(captureOutput(), { resolveRecipe: real }),
    );
    expect(r.steps.filter((s) => s.outcome === 'manual').map((s) => s.id)).toEqual([
      'add-sdk-init',
    ]);
    expect(r.incomplete).toBe(true);
    expect(exitCodeFor(r, true)).toBe(3);
  });

  it('a non-framework skip keeps the generic snippet with both module systems', async () => {
    sb = await sandbox('tsc-node');
    const file = join(sb.project, 'package.json');
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    const { start: _start, ...scripts } = pkg.scripts;
    await writeFile(file, JSON.stringify({ ...pkg, scripts, main: 'lib/index.js' }));
    const r = await runJavaScriptInstall(
      baseOpts(sb.project),
      makeDeps(captureOutput(), { resolveRecipe: real }),
    );
    const code = r.snippets?.[0]?.code ?? '';
    expect(code).toMatch(/First install the SDK: npm install @bugsee\/bugsee@beta/);
    expect(code).toContain('CommonJS');
  });

  it('a failed run rolled everything back: no snippet of a rolled-back step is printed or reported', async () => {
    sb = await sandbox('tsc-node');
    const file = join(sb.project, 'package.json');
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    const { start: _start, ...scripts } = pkg.scripts;
    await writeFile(file, JSON.stringify({ ...pkg, scripts }));
    // a later step fails: the upload script's path is a directory
    await mkdir(join(sb.project, 'scripts/bugsee-sourcemaps.mjs'), { recursive: true });
    const cap = captureOutput();
    const r = await runJavaScriptInstall(
      baseOpts(sb.project),
      makeDeps(cap, { resolveRecipe: real }),
    );
    expect(r.ok).toBe(false);
    expect(r.snippets).toBeUndefined();
    expect(cap.lines.join('\n')).not.toContain('Give Node the Bugsee token');
    expect(await readFile(join(sb.project, 'src/index.ts'), 'utf8')).not.toContain('bugsee');
  });

  it('a dry run predicts the real outcome: a missing env loader is a manual step, exit 3', async () => {
    sb = await sandbox('tsc-node');
    const file = join(sb.project, 'package.json');
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    const { start: _start, ...scripts } = pkg.scripts;
    await writeFile(file, JSON.stringify({ ...pkg, scripts }));
    const before = await tree(sb.project);
    const dry = await runJavaScriptInstall(
      baseOpts(sb.project, { dryRun: true }),
      makeDeps(captureOutput(), { resolveRecipe: real }),
    );
    expect(dry.steps.find((s) => s.id === 'add-sdk-init:node')?.outcome).toBe('manual');
    expect(dry.incomplete).toBe(true);
    expect(await tree(sb.project)).toEqual(before);
    const realRun = await runJavaScriptInstall(
      baseOpts(sb.project),
      makeDeps(captureOutput(), { resolveRecipe: real }),
    );
    expect(realRun.steps.find((s) => s.id === 'add-sdk-init:node')?.outcome).toBe('manual');
    expect(exitCodeFor(realRun, true)).toBe(exitCodeFor(dry, true));
  });

  it('after an install the plan says the init is already set up instead of promising an edit', async () => {
    sb = await sandbox('tsc-node');
    await runJavaScriptInstall(
      baseOpts(sb.project),
      makeDeps(captureOutput(), { resolveRecipe: real }),
    );
    const cap = captureOutput();
    await runJavaScriptInstall(
      baseOpts(sb.project, { dryRun: true }),
      makeDeps(cap, { resolveRecipe: real }),
    );
    const text = cap.lines.join('\n');
    expect(text).toContain('already set up');
    expect(text).not.toMatch(/adds import \{ launch \}/);
  });

  it('--runtime none leaves the code alone on purpose: not incomplete, no step', async () => {
    sb = await sandbox('tsc-node');
    const r = await runJavaScriptInstall(
      baseOpts(sb.project, { runtime: 'none' }),
      makeDeps(captureOutput(), { resolveRecipe: real }),
    );
    expect(r.incomplete).toBe(false);
    expect(r.steps.some((s) => s.id.startsWith('add-sdk-init'))).toBe(false);
    expect(real.mock.calls.map((c) => c[0].platform)).toEqual(['javascript-tsc']);
  });

  it('no runtime signal: nothing is guessed (incomplete); --runtime browser then initialises the entry', async () => {
    sb = await sandbox('tsc-node');
    await writeFile(
      join(sb.project, 'package.json'),
      JSON.stringify({ name: 'x', version: '1.0.0' }),
    );
    await rm(join(sb.project, 'tsconfig.json'));
    await rm(join(sb.project, 'src'), { recursive: true });
    await mkdir(join(sb.project, 'src'), { recursive: true });
    await writeFile(join(sb.project, 'src/main.js'), 'document.title = "x";\n');
    const first = await runJavaScriptInstall(
      baseOpts(sb.project),
      makeDeps(captureOutput(), { resolveRecipe: real }),
    );
    expect(first.incomplete).toBe(true);
    expect(first.snippets?.[0]?.code).toContain('--runtime');
    expect(await readFile(join(sb.project, 'src/main.js'), 'utf8')).toBe('document.title = "x";\n');
    await runJavaScriptUninstall(baseOpts(sb.project, { yes: true }), makeDeps(captureOutput()));
    const second = await runJavaScriptInstall(
      baseOpts(sb.project, { runtime: 'browser' }),
      makeDeps(captureOutput(), { resolveRecipe: real }),
    );
    expect(second.steps.find((s) => s.id === 'add-sdk-init:browser')?.outcome).toBe('applied');
    expect(await readFile(join(sb.project, 'src/main.js'), 'utf8')).toContain(`launch('${TOKEN}')`);
  });

  it('browser and server together in a non-interactive run: incomplete, naming --runtime', async () => {
    sb = await sandbox('tsc-node');
    await writeFile(
      join(sb.project, 'package.json'),
      JSON.stringify({
        name: 'x',
        scripts: { start: 'node a.js' },
        dependencies: { react: '18', express: '4' },
      }),
    );
    const r = await runJavaScriptInstall(
      baseOpts(sb.project),
      makeDeps(captureOutput(), { resolveRecipe: real }),
    );
    expect(r.incomplete).toBe(true);
    expect(r.snippets?.[0]?.code).toContain('--runtime');
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

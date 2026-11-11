import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeRecipe } from '../../../src/engine/execute.js';
import type { OpSpec, Recipe } from '../../../src/engine/recipe.js';
import { makeCtx, makeTmp, npmAt } from '../helpers.js';

/** A dry run must predict what the real run will hand back: the same decision, nothing written. */
let tmp: Awaited<ReturnType<typeof makeTmp>>;
beforeEach(async () => {
  tmp = await makeTmp();
});
afterEach(() => tmp.cleanup());

const recipe = (op: OpSpec): Recipe => ({
  schema: 1,
  id: 'x',
  kind: 'buildtool',
  platform: 'x',
  engine: { min: '0.0.0' },
  sdk: { range: '*' },
  detect: [],
  ops: [op],
});
const outcome = async (op: OpSpec, over = {}) => {
  const dry = await executeRecipe(recipe(op), makeCtx(tmp.dir, { dryRun: true, ...over }));
  const real = await executeRecipe(recipe(op), makeCtx(tmp.dir, over));
  return { dry, real };
};
const put = (rel: string, text: string): Promise<void> =>
  mkdir(join(tmp.dir, rel, '..'), { recursive: true }).then(() =>
    writeFile(join(tmp.dir, rel), text),
  );

describe('dry-run previews agree with the real run', () => {
  it('add-package-script with no script to chain into: manual in both, exit-3 material', async () => {
    await put('package.json', JSON.stringify({ name: 'x', scripts: { start: 'node a.js' } }));
    const op: OpSpec = {
      op: 'add-package-script',
      name: 'bugsee:up',
      command: 'x',
      chainInto: 'build',
    };
    const before = await readFile(join(tmp.dir, 'package.json'), 'utf8');
    const dry = await executeRecipe(
      recipe(op),
      makeCtx(tmp.dir, { dryRun: true, packageManager: npmAt(tmp.dir) }),
    );
    expect(dry.results[0]?.outcome).toBe('manual');
    expect(dry.incomplete).toBe(true);
    expect(await readFile(join(tmp.dir, 'package.json'), 'utf8')).toBe(before);
    const real = await executeRecipe(
      recipe(op),
      makeCtx(tmp.dir, { packageManager: npmAt(tmp.dir) }),
    );
    expect(real.results[0]?.outcome).toBe('manual');
  });

  it('add-package-script with a chain target: planned', async () => {
    await put('package.json', JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }));
    const op: OpSpec = {
      op: 'add-package-script',
      name: 'bugsee:up',
      command: 'x',
      chainInto: 'build',
    };
    const dry = await executeRecipe(
      recipe(op),
      makeCtx(tmp.dir, { dryRun: true, packageManager: npmAt(tmp.dir) }),
    );
    expect(dry.results[0]?.outcome).toBe('planned');
    expect(dry.incomplete).toBe(false);
  });

  it('set-json-key on a missing file: manual in both', async () => {
    const op: OpSpec = {
      op: 'set-json-key',
      file: 'tsconfig.json',
      path: ['compilerOptions', 'sourceMap'],
      value: true,
    };
    const { dry, real } = await outcome(op);
    expect(dry.results[0]?.outcome).toBe('manual');
    expect(real.results[0]?.outcome).toBe('manual');
  });

  it('set-json-key on an existing file: planned, and the file is untouched', async () => {
    await put('tsconfig.json', '{}\n');
    const op: OpSpec = { op: 'set-json-key', file: 'tsconfig.json', path: ['a'], value: 1 };
    const dry = await executeRecipe(recipe(op), makeCtx(tmp.dir, { dryRun: true }));
    expect(dry.results[0]?.outcome).toBe('planned');
    expect(await readFile(join(tmp.dir, 'tsconfig.json'), 'utf8')).toBe('{}\n');
  });

  it('write-env-var against a different existing value: manual in both (no token in the snippet)', async () => {
    await put('.env', 'BUGSEE_APP_TOKEN=someone_else\n');
    const op: OpSpec = {
      op: 'write-env-var',
      file: '.env',
      key: 'BUGSEE_APP_TOKEN',
      from: 'token',
    };
    const { dry, real } = await outcome(op);
    expect(dry.results[0]?.outcome).toBe('manual');
    expect(JSON.stringify(dry.results)).not.toContain('tok_SECRET');
    expect(real.results[0]?.outcome).toBe('manual');
  });

  it('write-env-var with no conflict: planned', async () => {
    const op: OpSpec = {
      op: 'write-env-var',
      file: '.env',
      key: 'BUGSEE_APP_TOKEN',
      from: 'token',
    };
    const dry = await executeRecipe(recipe(op), makeCtx(tmp.dir, { dryRun: true }));
    expect(dry.results[0]?.outcome).toBe('planned');
  });

  it('add-bundler-plugin: no config file and an unusual config are manual in the dry run too', async () => {
    const op: OpSpec = {
      op: 'add-bundler-plugin',
      target: 'vite',
      importFrom: '@bugsee/vite-plugin',
      importName: 'p',
      callArgs: '',
    };
    expect(
      (await executeRecipe(recipe(op), makeCtx(tmp.dir, { dryRun: true }))).results[0]?.outcome,
    ).toBe('manual');
    await put('vite.config.ts', 'export default makeConfig();\n');
    const dry = await executeRecipe(recipe(op), makeCtx(tmp.dir, { dryRun: true }));
    expect(dry.results[0]?.outcome).toBe('manual');
    expect(await readFile(join(tmp.dir, 'vite.config.ts'), 'utf8')).toBe(
      'export default makeConfig();\n',
    );
  });

  it('add-bundler-plugin: an editable config is planned, plus the source-map hint when asked', async () => {
    await put(
      'vite.config.ts',
      "import { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [] });\n",
    );
    const op: OpSpec = {
      op: 'add-bundler-plugin',
      target: 'vite',
      importFrom: '@bugsee/vite-plugin',
      importName: 'p',
      callArgs: '',
    };
    expect(
      (await executeRecipe(recipe(op), makeCtx(tmp.dir, { dryRun: true }))).results[0]?.outcome,
    ).toBe('planned');
    const withHint = await executeRecipe(
      recipe({ ...op, ensureSourcemap: true } as OpSpec),
      makeCtx(tmp.dir, { dryRun: true }),
    );
    expect(withHint.results[0]?.outcome).toBe('manual');
  });

  it('a dry run warns about a skipped large file exactly like the real run', async () => {
    const { opToStep } = await import('../../../src/engine/ops/index.js');
    await put('index.html', '<script type="module" src="/src/main.js"></script>');
    await put('src/main.js', 'run();\n');
    await put('src/generated/schema.js', `${'x'.repeat(600_000)}\n`);
    const op: OpSpec = { op: 'add-sdk-init', runtime: 'browser', importFrom: '@bugsee/bugsee' };
    const dryCtx = makeCtx(tmp.dir, { dryRun: true });
    await opToStep(op).preview?.(dryCtx);
    const realCtx = makeCtx(tmp.dir);
    await opToStep(op).apply(realCtx);
    const pick = (logs: string[]) => logs.filter((l) => l.includes('schema.js'));
    expect(pick(dryCtx.logs).length).toBe(1);
    expect(pick(dryCtx.logs)).toEqual(pick(realCtx.logs));
  });
});

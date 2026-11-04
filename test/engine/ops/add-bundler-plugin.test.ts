import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeRecipe } from '../../../src/engine/execute.js';
import { opToStep } from '../../../src/engine/ops/index.js';
import { type OpSpec, parseRecipe } from '../../../src/engine/recipe.js';
import { makeCtx, makeTmp } from '../helpers.js';

const spec: OpSpec = {
  op: 'add-bundler-plugin',
  target: 'vite',
  importFrom: '@bugsee/vite-plugin',
  importName: 'bugsee',
  callArgs: '{ app: "x" }',
};
let tmp: Awaited<ReturnType<typeof makeTmp>>;
beforeEach(async () => {
  tmp = await makeTmp();
});
afterEach(() => tmp.cleanup());

const CONFIG =
  "import { defineConfig } from 'vite';\nexport default defineConfig({\n  plugins: [],\n});\n";
const cfg = (name = 'vite.config.ts'): string => join(tmp.dir, name);

describe('add-bundler-plugin op', () => {
  it('id and title', () => {
    const step = opToStep(spec);
    expect(step.id).toBe('add-bundler-plugin:vite');
    expect(step.title).toContain('vite');
  });

  it('adds the plugin, records the marker, is then satisfied; rollback restores exact bytes', async () => {
    await writeFile(cfg(), CONFIG);
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    expect(await step.apply(ctx)).toBeUndefined();
    const after = await readFile(cfg(), 'utf8');
    expect(after).toContain('@bugsee/vite-plugin');
    expect(after).toContain('bugsee({ app: "x" })');
    expect(ctx.entries).toEqual([
      { file: 'vite.config.ts', action: 'edited', before: CONFIG, after, marker: 'bugsee-wizard' },
    ]);
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await step.rollback(ctx);
    expect(await readFile(cfg(), 'utf8')).toBe(CONFIG);
  });

  it('finds the config for the right target (webpack.config.js)', async () => {
    await writeFile(cfg('webpack.config.js'), 'module.exports = { plugins: [] };\n');
    const ctx = makeCtx(tmp.dir);
    const step = opToStep({ ...spec, target: 'webpack' } as OpSpec);
    await step.apply(ctx);
    expect(await readFile(cfg('webpack.config.js'), 'utf8')).toContain('bugsee(');
    await expect(readFile(cfg())).rejects.toBeDefined();
  });

  it('no config file: pending, apply returns a manual snippet naming the plugin, writes nothing', async () => {
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    const res = await step.apply(ctx);
    expect(res?.manual?.file).toBe('vite.config.ts');
    expect(res?.manual?.code).toContain("import { bugsee } from '@bugsee/vite-plugin';");
    expect(res?.manual?.code).toContain('bugsee({ app: "x" })');
    expect(ctx.entries).toEqual([{ file: 'vite.config.ts', action: 'manual' }]);
  });

  it('an unusual config shape yields a manual snippet and leaves the file untouched', async () => {
    const odd = 'export default makeConfig();\n';
    await writeFile(cfg(), odd);
    const ctx = makeCtx(tmp.dir);
    const res = await opToStep(spec).apply(ctx);
    expect(res?.manual?.file).toBe('vite.config.ts');
    expect(res?.manual?.title).toContain('vite.config.ts');
    expect(await readFile(cfg(), 'utf8')).toBe(odd);
    expect(ctx.entries).toEqual([{ file: 'vite.config.ts', action: 'manual' }]);
  });

  it('is satisfied when the marker is already present and apply changes nothing', async () => {
    const done = `// bugsee-wizard\n${CONFIG}`;
    await writeFile(cfg(), done);
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await step.apply(ctx);
    expect(await readFile(cfg(), 'utf8')).toBe(done);
    expect(ctx.entries).toEqual([]);
  });

  describe('ensureSourcemap is never silently ignored', () => {
    const hints: Array<['vite' | 'rollup' | 'webpack' | 'rspack', string]> = [
      ['vite', 'build: { sourcemap: true }'],
      ['rollup', 'output: { sourcemap: true }'],
      ['webpack', "devtool: 'source-map'"],
      ['rspack', "devtool: 'source-map'"],
    ];
    for (const [target, hint] of hints) {
      it(`${target}: plugin is edited, then a manual snippet covers only the source-map part`, async () => {
        const file = cfg(`${target}.config.js`);
        await writeFile(file, 'export default { plugins: [] };\n');
        const ctx = makeCtx(tmp.dir);
        const res = await opToStep({ ...spec, target, ensureSourcemap: true } as OpSpec).apply(ctx);
        expect(await readFile(file, 'utf8')).toContain('bugsee(');
        expect(res?.manual?.code).toContain(hint);
        expect(res?.manual?.code).not.toContain('import');
        expect(res?.manual?.file).toBe(`${target}.config.js`);
        expect(ctx.entries).toHaveLength(1);
        expect(ctx.entries[0]?.action).toBe('edited');
      });
    }

    it('no config: the single manual snippet carries both the plugin and the source-map hint', async () => {
      const res = await opToStep({ ...spec, ensureSourcemap: true } as OpSpec).apply(
        makeCtx(tmp.dir),
      );
      expect(res?.manual?.code).toContain('bugsee({ app: "x" })');
      expect(res?.manual?.code).toContain('build: { sourcemap: true }');
    });

    it('odd config: plugin snippet and source-map hint both returned', async () => {
      await writeFile(cfg(), 'export default makeConfig();\n');
      const res = await opToStep({ ...spec, ensureSourcemap: true } as OpSpec).apply(
        makeCtx(tmp.dir),
      );
      expect(res?.manual?.code).toContain('build: { sourcemap: true }');
    });

    it('ensureSourcemap false/absent adds no hint', async () => {
      await writeFile(cfg(), CONFIG);
      const res = await opToStep({ ...spec, ensureSourcemap: false } as OpSpec).apply(
        makeCtx(tmp.dir),
      );
      expect(res).toBeUndefined();
    });
  });

  describe('ensureSourcemap stays rollback-covered and re-reported', () => {
    const smSpec = { ...spec, ensureSourcemap: true } as OpSpec;

    it('flags the manual result as applied so a later failure rolls the config back', async () => {
      await writeFile(cfg(), CONFIG);
      const ctx = makeCtx(tmp.dir);
      const res = await opToStep(smSpec).apply(ctx);
      expect(res?.applied).toBe(true);
      expect(res?.manual).toBeDefined();
    });

    it('end to end: a later failing step restores vite.config.ts', async () => {
      await writeFile(cfg(), CONFIG);
      await writeFile(join(tmp.dir, 'package.json'), '{"scripts":{"up":"other"}}');
      const res = await executeRecipe(
        parseRecipe({
          schema: 1,
          id: 'r',
          kind: 'buildtool',
          platform: 'javascript-vite',
          engine: { min: '1.0.0' },
          sdk: { range: '*' },
          detect: [],
          ops: [smSpec, { op: 'add-package-script', name: 'up', command: 'echo up' }],
        }),
        makeCtx(tmp.dir),
      );
      expect(res.failed).toBe(true);
      expect(res.results.map((r) => r.outcome)).toEqual(['manual', 'blocked', 'rolled-back']);
      expect(await readFile(cfg(), 'utf8')).toBe(CONFIG);
    });

    it('a re-run still reports pending, and apply re-emits ONLY the hint without editing', async () => {
      await writeFile(cfg(), CONFIG);
      const step = opToStep(smSpec);
      await step.apply(makeCtx(tmp.dir));
      const edited = await readFile(cfg(), 'utf8');
      const ctx = makeCtx(tmp.dir);
      expect(await opToStep(smSpec).precheck(ctx)).toEqual({ kind: 'pending' });
      const res = await opToStep(smSpec).apply(ctx);
      expect(res?.manual?.code).toContain('build: { sourcemap: true }');
      expect(res?.manual?.code).not.toContain('import');
      expect(res?.applied).toBeUndefined();
      expect(await readFile(cfg(), 'utf8')).toBe(edited);
      expect(ctx.entries).toEqual([]);
    });

    it('is satisfied once the config has a sourcemap/devtool setting', async () => {
      await writeFile(
        cfg(),
        `// bugsee-wizard\n${CONFIG.replace('plugins: []', 'plugins: [], build: { sourcemap: true }')}`,
      );
      expect(await opToStep(smSpec).precheck(makeCtx(tmp.dir))).toEqual({ kind: 'satisfied' });
      await writeFile(
        cfg('webpack.config.js'),
        '// bugsee-wizard\nmodule.exports = { devtool: "source-map", plugins: [] };\n',
      );
      expect(
        await opToStep({ ...smSpec, target: 'webpack' } as OpSpec).precheck(makeCtx(tmp.dir)),
      ).toEqual({
        kind: 'satisfied',
      });
    });

    it('a setting already present means the plugin edit returns no manual hint', async () => {
      await writeFile(
        cfg(),
        CONFIG.replace('plugins: []', 'plugins: [], build: { sourcemap: true }'),
      );
      const res = await opToStep(smSpec).apply(makeCtx(tmp.dir));
      expect(res).toBeUndefined();
    });

    it('an odd config that already sets a source map gets only the plugin snippet', async () => {
      await writeFile(cfg(), 'export default makeConfig({ sourcemap: true });\n');
      const res = await opToStep(smSpec).apply(makeCtx(tmp.dir));
      expect(res?.manual?.code).toContain('bugsee({ app: "x" })');
      expect(res?.manual?.code).not.toContain('enable source maps');
    });

    it('without ensureSourcemap a marked config stays satisfied', async () => {
      await writeFile(cfg(), `// bugsee-wizard\n${CONFIG}`);
      expect(await opToStep(spec).precheck(makeCtx(tmp.dir))).toEqual({ kind: 'satisfied' });
    });
  });

  it('rollback before apply is a no-op', async () => {
    await writeFile(cfg(), CONFIG);
    await opToStep(spec).rollback(makeCtx(tmp.dir));
    expect(await readFile(cfg(), 'utf8')).toBe(CONFIG);
  });
});

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeRecipe } from '../../../src/engine/execute.js';
import { opToStep } from '../../../src/engine/ops/index.js';
import { type OpSpec, parseRecipe, type Recipe } from '../../../src/engine/recipe.js';
import { makeCtx, makeTmp } from '../helpers.js';

const spec: Extract<OpSpec, { op: 'show-snippet' }> = {
  op: 'show-snippet',
  file: 'nuxt.config.ts',
  title: 'Register the Bugsee module',
  code: "modules: ['@bugsee/nuxt'],",
  doneWhen: { files: ['nuxt.config.ts', 'nuxt.config.js'], contains: '@bugsee/nuxt' },
};
let tmp: Awaited<ReturnType<typeof makeTmp>>;
beforeEach(async () => {
  tmp = await makeTmp();
});
afterEach(() => tmp.cleanup());

describe('show-snippet op', () => {
  it('id and title', () => {
    const step = opToStep(spec);
    expect(step.id).toBe('show-snippet:nuxt.config.ts:Register the Bugsee module');
    expect(step.title).toBe('Register the Bugsee module');
  });

  it('is pending, hands the snippet back as a manual step and records a manual entry; writes nothing', async () => {
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    expect(await step.apply(ctx)).toEqual({
      manual: {
        file: 'nuxt.config.ts',
        title: 'Register the Bugsee module',
        code: "modules: ['@bugsee/nuxt'],",
      },
    });
    expect(ctx.entries).toEqual([{ file: 'nuxt.config.ts', action: 'manual' }]);
  });

  it('a dry run predicts the same manual step', async () => {
    const step = opToStep(spec);
    expect(await step.preview?.(makeCtx(tmp.dir))).toEqual({
      manual: { file: spec.file, title: spec.title, code: spec.code },
    });
  });

  it('is satisfied once any listed file already contains the text, and not before', async () => {
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    await writeFile(join(tmp.dir, 'nuxt.config.ts'), 'export default {};\n');
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    await writeFile(join(tmp.dir, 'nuxt.config.js'), "modules: ['@bugsee/nuxt']\n");
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('without doneWhen it is always pending', async () => {
    const { doneWhen: _drop, ...bare } = spec;
    const step = opToStep(bare);
    await writeFile(join(tmp.dir, 'nuxt.config.ts'), '@bugsee/nuxt');
    expect(await step.precheck(makeCtx(tmp.dir))).toEqual({ kind: 'pending' });
  });

  it('two snippets for one file have different ids', () => {
    expect(opToStep({ ...spec, title: 'Another' }).id).not.toBe(opToStep(spec).id);
  });

  it('a doneWhen path that escapes the package directory never counts as done', async () => {
    const step = opToStep({
      ...spec,
      doneWhen: { files: ['../outside.txt'], contains: 'x' },
    });
    expect(await step.precheck(makeCtx(tmp.dir))).toEqual({ kind: 'pending' });
  });

  it('rollback changes nothing and the run is incomplete (exit 3 material)', async () => {
    const recipe: Recipe = {
      schema: 1,
      id: 'x',
      kind: 'framework',
      platform: 'x',
      engine: { min: '0.0.0' },
      sdk: { range: '*' },
      detect: [],
      ops: [spec],
    };
    const ctx = makeCtx(tmp.dir);
    const run = await executeRecipe(recipe, ctx);
    expect(run.incomplete).toBe(true);
    expect(run.results[0]?.outcome).toBe('manual');
    await opToStep(spec).rollback(ctx);
  });
});

describe('show-snippet validation', () => {
  const withOp = (op: Record<string, unknown>): Record<string, unknown> => ({
    schema: 1,
    id: 'x',
    kind: 'framework',
    platform: 'x',
    engine: { min: '0.0.0' },
    sdk: { range: '*' },
    detect: [],
    ops: [op],
  });
  const violations = (json: unknown): string[] => {
    try {
      parseRecipe(json);
      return [];
    } catch (e) {
      return [...(e as { violations: string[] }).violations];
    }
  };
  const op = (x: Record<string, unknown> = {}): Record<string, unknown> => ({
    op: 'show-snippet',
    file: 'a.ts',
    title: 'T',
    code: 'c',
    ...x,
  });

  it('accepts the minimal and the full form, and keeps every field', () => {
    expect(violations(withOp(op()))).toEqual([]);
    expect(parseRecipe(withOp(op())).ops).toEqual([
      { op: 'show-snippet', file: 'a.ts', title: 'T', code: 'c' },
    ]);
    const full = op({ doneWhen: { files: ['a.ts'], contains: 'x' } });
    expect(violations(withOp(full))).toEqual([]);
    expect(parseRecipe(withOp(full)).ops).toEqual([
      {
        op: 'show-snippet',
        file: 'a.ts',
        title: 'T',
        code: 'c',
        doneWhen: { files: ['a.ts'], contains: 'x' },
      },
    ]);
  });

  it('rejects unknown keys, empty fields and unsafe paths', () => {
    expect(violations(withOp(op({ extra: 1 })))).toEqual(['recipe.ops[0].extra: unknown key']);
    expect(violations(withOp(op({ title: '' })))).toEqual([
      'recipe.ops[0].title: must not be empty',
    ]);
    expect(violations(withOp(op({ code: 3 })))).toEqual(['recipe.ops[0].code: must be a string']);
    expect(violations(withOp(op({ file: '../a.ts' })))).toEqual([
      'recipe.ops[0].file: must not escape the package directory via ".."',
    ]);
    expect(violations(withOp(op({ doneWhen: { files: [], contains: 'x' } })))).toEqual([
      'recipe.ops[0].doneWhen.files: must not be empty',
    ]);
    expect(violations(withOp(op({ doneWhen: { files: ['/etc/x'], contains: 'x' } })))).toEqual([
      'recipe.ops[0].doneWhen.files[0]: must be relative, not absolute',
    ]);
    expect(violations(withOp(op({ doneWhen: { files: ['a'], contains: '' } })))).toEqual([
      'recipe.ops[0].doneWhen.contains: must not be empty',
    ]);
    expect(violations(withOp(op({ doneWhen: 'x' })))).toEqual([
      'recipe.ops[0].doneWhen: must be an object',
    ]);
  });

  it('refuses the token placeholder: a secret is never printed from a recipe', () => {
    expect(violations(withOp(op({ code: 'launch("{{token}}")' })))).toEqual([
      'recipe.ops[0].code: must not contain {{token}} (secrets are never written from a template)',
    ]);
  });
});

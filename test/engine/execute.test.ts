import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeRecipe } from '../../src/engine/execute.js';
import { opToStep } from '../../src/engine/ops/index.js';
import { parseRecipe } from '../../src/engine/recipe.js';
import { makeCtx, makeTmp } from './helpers.js';

let tmp: Awaited<ReturnType<typeof makeTmp>>;
beforeEach(async () => {
  tmp = await makeTmp();
});
afterEach(() => tmp.cleanup());

const recipe = (ops: unknown[]) =>
  parseRecipe({
    schema: 1,
    id: 'r',
    kind: 'buildtool',
    platform: 'javascript-vite',
    engine: { min: '1.0.0' },
    sdk: { range: '*' },
    detect: [],
    ops,
  });

const OPS = [
  { op: 'ensure-gitignore', line: '.env.bugsee-build-plugin' },
  { op: 'write-env-var', file: '.env.bugsee-build-plugin', key: 'BUGSEE_TOKEN', from: 'token' },
  { op: 'write-file', path: 'bugsee/readme.txt', template: 'hi' },
  { op: 'add-package-script', name: 'up', command: 'echo up' },
  { op: 'set-json-key', file: 'missing.json', path: ['a'], value: 1 },
];

describe('executeRecipe', () => {
  it('runs the ops in order; second run skips everything (idempotent); manual => incomplete', async () => {
    await writeFile(join(tmp.dir, 'package.json'), '{"name":"x"}\n');
    const ctx = makeCtx(tmp.dir);
    const first = await executeRecipe(recipe(OPS), ctx);
    expect(first.failed).toBe(false);
    expect(first.incomplete).toBe(true);
    expect(first.results.map((r) => [r.id, r.outcome])).toEqual([
      ['ensure-gitignore:.env.bugsee-build-plugin', 'applied'],
      ['write-env-var:.env.bugsee-build-plugin:BUGSEE_TOKEN', 'applied'],
      ['write-file:bugsee/readme.txt', 'applied'],
      ['add-package-script:up', 'applied'],
      ['set-json-key:missing.json#a', 'manual'],
    ]);
    expect(first.results[4]?.snippet?.file).toBe('missing.json');

    const second = await executeRecipe(recipe(OPS.slice(0, 4)), makeCtx(tmp.dir));
    expect(second.results.map((r) => r.outcome)).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ]);
  });

  it('a blocked op fails the run and rolls back earlier ops byte-for-byte', async () => {
    await writeFile(join(tmp.dir, 'package.json'), '{"name":"x","scripts":{"up":"other"}}\n');
    const ctx = makeCtx(tmp.dir);
    const res = await executeRecipe(recipe(OPS), ctx);
    expect(res.failed).toBe(true);
    expect(res.results.map((r) => r.outcome)).toEqual([
      'applied',
      'applied',
      'applied',
      'blocked',
      'rolled-back',
      'rolled-back',
      'rolled-back',
    ]);
    for (const f of ['.gitignore', '.env.bugsee-build-plugin', 'bugsee']) {
      await expect(readFile(join(tmp.dir, f))).rejects.toBeDefined();
    }
  });

  it('the token never appears in results or logs', async () => {
    await writeFile(join(tmp.dir, 'package.json'), '{}');
    const ctx = makeCtx(tmp.dir);
    const res = await executeRecipe(recipe(OPS), ctx);
    expect(JSON.stringify(res) + ctx.logs.join('\n') + JSON.stringify(ctx.entries)).not.toContain(
      'tok_SECRET',
    );
  });

  it('dry-run changes nothing', async () => {
    const ctx = makeCtx(tmp.dir, { dryRun: true });
    const res = await executeRecipe(recipe(OPS.slice(0, 3)), ctx);
    expect(res.results.every((r) => r.outcome === 'planned')).toBe(true);
    await expect(readFile(join(tmp.dir, '.gitignore'))).rejects.toBeDefined();
    expect(ctx.entries).toEqual([]);
  });

  it('an empty recipe succeeds with no results', async () => {
    expect(await executeRecipe(recipe([]), makeCtx(tmp.dir))).toEqual({
      results: [],
      failed: false,
      incomplete: false,
    });
  });
});

describe('opToStep', () => {
  it('throws on an op outside the closed set (never executes unknown ops)', () => {
    expect(() => opToStep({ op: 'run-shell', cmd: 'rm -rf /' } as never)).toThrow(
      /Unknown operation/,
    );
  });
});

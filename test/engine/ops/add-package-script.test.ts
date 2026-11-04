import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScriptCommand } from '../../../src/engine/ops/add-package-script.js';
import { opToStep } from '../../../src/engine/ops/index.js';
import type { OpSpec } from '../../../src/engine/recipe.js';
import { makeCtx, makeTmp, npmAt } from '../helpers.js';

const spec: OpSpec = {
  op: 'add-package-script',
  name: 'bugsee:upload',
  command: 'bugsee-cli upload',
  chainInto: 'build',
};
let tmp: Awaited<ReturnType<typeof makeTmp>>;
beforeEach(async () => {
  tmp = await makeTmp();
});
afterEach(() => tmp.cleanup());

const PKG = '{\n    "name": "x",\n    "scripts": {\n        "build": "vite build"\n    }\n}\n';
const write = (s: string): Promise<void> => writeFile(join(tmp.dir, 'package.json'), s);
const read = (): Promise<string> => readFile(join(tmp.dir, 'package.json'), 'utf8');
const scripts = async (): Promise<Record<string, string>> =>
  (JSON.parse(await read()) as { scripts: Record<string, string> }).scripts;

describe('runScriptCommand', () => {
  it('uses the detected pm, npm by default, deno task for deno', () => {
    expect(runScriptCommand(null, 'a')).toBe('npm run a');
    expect(runScriptCommand({ ...npmAt('/'), name: 'pnpm' }, 'a')).toBe('pnpm run a');
    expect(runScriptCommand({ ...npmAt('/'), name: 'yarn' }, 'a')).toBe('yarn run a');
    expect(runScriptCommand({ ...npmAt('/'), name: 'deno' }, 'a')).toBe('deno task a');
  });
});

describe('add-package-script op', () => {
  it('id and title', () => {
    const step = opToStep(spec);
    expect(step.id).toBe('add-package-script:bugsee:upload');
    expect(step.title).toContain('bugsee:upload');
  });

  it('adds the script and chains it into build; preserves format; rollback restores exact bytes', async () => {
    await write(PKG);
    const ctx = makeCtx(tmp.dir, { packageManager: { ...npmAt(tmp.dir), name: 'pnpm' } });
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    await step.apply(ctx);
    expect(await scripts()).toEqual({
      build: 'vite build && pnpm run bugsee:upload',
      'bugsee:upload': 'bugsee-cli upload',
    });
    expect(await read()).toContain('\n        "build"');
    expect(ctx.entries).toEqual([
      { file: 'package.json', action: 'edited', before: PKG, after: await read() },
    ]);
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await step.rollback(ctx);
    expect(await read()).toBe(PKG);
  });

  it('skips chaining (with a note) when the chainInto script does not exist', async () => {
    await write('{"name":"x"}\n');
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    await step.apply(ctx);
    expect(await scripts()).toEqual({ 'bugsee:upload': 'bugsee-cli upload' });
    expect(ctx.logs.join('\n')).toContain('No "build" script to chain into');
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('without chainInto only adds the script', async () => {
    await write(PKG);
    const step = opToStep({ op: 'add-package-script', name: 'x', command: 'y' });
    await step.apply(makeCtx(tmp.dir));
    expect((await scripts()).build).toBe('vite build');
    expect((await scripts()).x).toBe('y');
  });

  it('is satisfied when script and chain are already there; apply is then a no-op', async () => {
    const done = JSON.stringify({
      scripts: {
        build: 'vite build && npm run bugsee:upload',
        'bugsee:upload': 'bugsee-cli upload',
      },
    });
    await write(done);
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await step.apply(ctx);
    expect(await read()).toBe(done);
    expect(ctx.entries).toEqual([]);
  });

  it('is pending when the script exists with the same command but is not chained yet', async () => {
    await write(
      JSON.stringify({ scripts: { build: 'vite build', 'bugsee:upload': 'bugsee-cli upload' } }),
    );
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    await step.apply(ctx);
    expect((await scripts()).build).toBe('vite build && npm run bugsee:upload');
  });

  it('is blocked when the script exists with a different command, file untouched', async () => {
    const src = JSON.stringify({ scripts: { 'bugsee:upload': 'something else' } });
    await write(src);
    const status = await opToStep(spec).precheck(makeCtx(tmp.dir));
    expect(status).toMatchObject({ kind: 'blocked' });
    expect(status.kind === 'blocked' && status.reason).toContain('bugsee:upload');
    expect(await read()).toBe(src);
  });

  it('is blocked without a package.json', async () => {
    expect(await opToStep(spec).precheck(makeCtx(tmp.dir))).toMatchObject({ kind: 'blocked' });
  });

  it('tolerates a non-object scripts field by replacing nothing it does not understand', async () => {
    await write('{"name":"x","scripts":[]}');
    const step = opToStep({ op: 'add-package-script', name: 'a', command: 'b' });
    expect(await step.precheck(makeCtx(tmp.dir))).toEqual({ kind: 'pending' });
  });

  it('rollback before apply is a no-op', async () => {
    await write(PKG);
    await opToStep(spec).rollback(makeCtx(tmp.dir));
    expect(await read()).toBe(PKG);
  });
});

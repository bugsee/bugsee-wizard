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
  it('uses the detected pm, npm by default', () => {
    expect(runScriptCommand(null, 'a')).toBe('npm run a');
    expect(runScriptCommand({ ...npmAt('/'), name: 'pnpm' }, 'a')).toBe('pnpm run a');
    expect(runScriptCommand({ ...npmAt('/'), name: 'yarn' }, 'a')).toBe('yarn run a');
  });
});

describe('add-package-script op', () => {
  it('id and title', () => {
    const step = opToStep(spec);
    expect(step.id).toBe('add-package-script:bugsee:upload');
    expect(step.title).toContain('bugsee:upload');
  });

  it('the plan discloses that the script is chained into build; no chain, no mention', () => {
    expect(opToStep(spec).title).toContain('run it after "build"');
    const { chainInto: _drop, ...plain } = spec as typeof spec & { chainInto?: string };
    expect(opToStep(plain).title).not.toContain('build');
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

  it('chainInto missing: a manual snippet (package.json still edited, rollback-covered), and re-runs keep reporting it', async () => {
    await write('{"name":"x"}\n');
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    const res = await step.apply(ctx);
    expect(await scripts()).toEqual({ 'bugsee:upload': 'bugsee-cli upload' });
    expect(res?.applied).toBe(true);
    expect(res?.manual?.file).toBe('package.json');
    expect(res?.manual?.code).toContain('npm run bugsee:upload');
    expect(res?.manual?.title).toContain('"build"');
    // re-run: still pending, apply changes nothing but still reports the manual step
    const ctx2 = makeCtx(tmp.dir);
    expect(await opToStep(spec).precheck(ctx2)).toEqual({ kind: 'pending' });
    const again = await opToStep(spec).apply(ctx2);
    expect(again?.manual?.code).toContain('npm run bugsee:upload');
    expect(again?.applied).toBeUndefined();
    expect(ctx2.entries).toEqual([]);
    await step.rollback(ctx);
    expect(await read()).toBe('{"name":"x"}\n');
  });

  it('matches the chained command on a boundary (npm run up is not npm run upload)', async () => {
    const mk = (build: string) => write(JSON.stringify({ scripts: { build, up: 'echo up' } }));
    const up = {
      op: 'add-package-script',
      name: 'up',
      command: 'echo up',
      chainInto: 'build',
    } as const;
    await mk('vite build && npm run upload');
    expect(await opToStep(up).precheck(makeCtx(tmp.dir))).toEqual({ kind: 'pending' });
    await opToStep(up).apply(makeCtx(tmp.dir));
    expect((await scripts()).build).toBe('vite build && npm run upload && npm run up');
    expect(await opToStep(up).precheck(makeCtx(tmp.dir))).toEqual({ kind: 'satisfied' });
    await mk('npm run up:fast');
    expect(await opToStep(up).precheck(makeCtx(tmp.dir))).toEqual({ kind: 'pending' });
    await mk('npm run up');
    expect(await opToStep(up).precheck(makeCtx(tmp.dir))).toEqual({ kind: 'satisfied' });
    await mk('pnpm run up');
    expect(await opToStep(up).precheck(makeCtx(tmp.dir))).toEqual({ kind: 'pending' });
    await mk('a;npm run up;b');
    expect(await opToStep(up).precheck(makeCtx(tmp.dir))).toEqual({ kind: 'satisfied' });
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

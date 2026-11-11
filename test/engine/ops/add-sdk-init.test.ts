import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeRecipe } from '../../../src/engine/execute.js';
import { createManifestRecorder, rollbackFromManifest } from '../../../src/engine/manifest.js';
import { opToStep } from '../../../src/engine/ops/index.js';
import type { OpSpec, Recipe } from '../../../src/engine/recipe.js';
import { makeCtx, makeTmp } from '../helpers.js';

type Spec = Extract<OpSpec, { op: 'add-sdk-init' }>;
const browser: Spec = { op: 'add-sdk-init', runtime: 'browser', importFrom: '@bugsee/bugsee' };
const viteBrowser: Spec = { ...browser, tokenExpr: 'import.meta.env.VITE_BUGSEE_APP_TOKEN' };
const node: Spec = {
  op: 'add-sdk-init',
  runtime: 'node',
  importFrom: '@bugsee/bugsee',
  tokenExpr: 'process.env.BUGSEE_APP_TOKEN',
};
const bun: Spec = { ...node, runtime: 'bun', importFrom: '@bugsee/bun' };

let tmp: Awaited<ReturnType<typeof makeTmp>>;
beforeEach(async () => {
  tmp = await makeTmp();
});
afterEach(() => tmp.cleanup());

const abs = (rel: string): string => join(tmp.dir, rel);
async function put(rel: string, content: string): Promise<void> {
  await mkdir(dirname(abs(rel)), { recursive: true });
  await writeFile(abs(rel), content);
}
const read = (rel: string): Promise<string> => readFile(abs(rel), 'utf8');

const MAIN =
  "import { createRoot } from 'react-dom/client';\nimport App from './App';\n\ncreateRoot(document.body).render(App());\n";

describe('add-sdk-init op', () => {
  it('id and title name the runtime and never include the token', () => {
    const step = opToStep(browser);
    expect(step.id).toBe('add-sdk-init:browser');
    expect(step.title).toContain('browser');
    expect(step.title + step.id).not.toContain('tok_SECRET');
  });

  it('browser: edits the entry named by index.html, records it with the marker, rolls back exactly', async () => {
    await put('index.html', '<script type="module" src="/src/main.js"></script>');
    await put('src/main.js', MAIN);
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(browser);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    expect(await step.apply(ctx)).toBeUndefined();
    const after = await read('src/main.js');
    expect(after).toContain("import { launch } from '@bugsee/bugsee'; // bugsee-wizard");
    expect(after).toContain("launch('tok_SECRET_123'); // bugsee-wizard");
    expect(ctx.entries).toEqual([
      { file: 'src/main.js', action: 'edited', before: MAIN, after, marker: 'bugsee-wizard' },
    ]);
    expect(ctx.logs.join('\n')).not.toContain('tok_SECRET');
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await step.rollback(ctx);
    expect(await read('src/main.js')).toBe(MAIN);
  });

  it('a token expression never writes the token into the code, and needs no token to plan', async () => {
    await put('src/main.js', MAIN);
    const ctx = makeCtx(tmp.dir, { token: '' });
    const step = opToStep(viteBrowser);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    await step.apply(ctx);
    const after = await read('src/main.js');
    expect(after).toContain('launch(import.meta.env.VITE_BUGSEE_APP_TOKEN);');
  });

  it('a literal token is required: no token is a blocked step', async () => {
    await put('src/main.js', MAIN);
    const step = opToStep(browser);
    const res = await step.precheck(makeCtx(tmp.dir, { token: '' }));
    expect(res.kind).toBe('blocked');
  });

  it('TypeScript with no Vite env types gets a vite/client reference; with them it does not', async () => {
    await put('src/main.ts', MAIN);
    const ctx = makeCtx(tmp.dir);
    await opToStep(viteBrowser).apply(ctx);
    expect((await read('src/main.ts')).startsWith('/// <reference types="vite/client" />\n')).toBe(
      true,
    );

    await put('src/main.ts', MAIN);
    await put('src/vite-env.d.ts', '/// <reference types="vite/client" />\n');
    await opToStep(viteBrowser).apply(makeCtx(tmp.dir));
    expect(await read('src/main.ts')).not.toContain('vite/client');
  });

  it('Vite env types declared in tsconfig "types" count too', async () => {
    await put('src/main.ts', MAIN);
    await put('tsconfig.json', '{ "compilerOptions": { "types": ["vite/client"] } }');
    await opToStep(viteBrowser).apply(makeCtx(tmp.dir));
    expect(await read('src/main.ts')).not.toContain('vite/client');
  });

  it('node: the start script names the entry; package type picks ESM or CommonJS', async () => {
    await put('package.json', JSON.stringify({ scripts: { start: 'node server.js' } }));
    await put('server.js', "const http = require('http');\nhttp.createServer();\n");
    const ctx = makeCtx(tmp.dir);
    await opToStep(node).apply(ctx);
    const cjs = await read('server.js');
    expect(cjs).toContain("const { launch } = require('@bugsee/bugsee'); // bugsee-wizard");
    expect(cjs).toContain('launch(process.env.BUGSEE_APP_TOKEN);');

    await put(
      'package.json',
      JSON.stringify({ type: 'module', scripts: { start: 'node server.js' } }),
    );
    await put('server.js', 'console.log(1);\n');
    await opToStep(node).apply(makeCtx(tmp.dir));
    expect(await read('server.js')).toContain(
      "import { launch } from '@bugsee/bugsee'; // bugsee-wizard",
    );
  });

  it('bun: imports from the bun package', async () => {
    await put('package.json', JSON.stringify({ type: 'module' }));
    await put('index.ts', 'Bun.serve({ fetch: () => new Response("ok") });\n');
    await opToStep(bun).apply(makeCtx(tmp.dir));
    const out = await read('index.ts');
    expect(out).toContain("import { launch } from '@bugsee/bun'; // bugsee-wizard");
    expect(out).toContain('launch(process.env.BUGSEE_APP_TOKEN as string);');
  });

  it('is satisfied, and changes nothing, when the user already integrated a Bugsee package', async () => {
    const mine = "import { launch } from '@bugsee/bugsee';\nlaunch('x');\n";
    await put('src/main.js', mine);
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(browser);
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await step.apply(ctx);
    expect(await read('src/main.js')).toBe(mine);
    expect(ctx.entries).toEqual([]);
  });

  it('no entry file: pending, apply hands back a manual snippet without the token and writes nothing', async () => {
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(browser);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    const res = await step.apply(ctx);
    expect(res?.manual?.code).toContain("import { launch } from '@bugsee/bugsee'");
    expect(res?.manual?.code).not.toContain('tok_SECRET');
    expect(res?.manual?.title).toMatch(/entry/i);
    expect(ctx.entries).toEqual([{ file: res?.manual?.file, action: 'manual' }]);
    expect(res?.applied).toBeUndefined();
  });

  it('an entry that cannot be parsed is left untouched with a manual snippet naming the file', async () => {
    const broken = 'import {{{ nope\n';
    await put('src/main.js', broken);
    const ctx = makeCtx(tmp.dir);
    const res = await opToStep(browser).apply(ctx);
    expect(res?.manual?.file).toBe('src/main.js');
    expect(res?.manual?.code).toContain('@bugsee/bugsee');
    expect(res?.manual?.code).not.toContain('tok_SECRET');
    expect(await read('src/main.js')).toBe(broken);
    expect(ctx.entries).toEqual([{ file: 'src/main.js', action: 'manual' }]);
  });

  it('refuses an entry that is a symlink out of the package (blocked, nothing written)', async () => {
    const outside = join(tmp.dir, '..', `outside-${Date.now()}.js`);
    await writeFile(outside, 'run();\n');
    await mkdir(abs('pkg/src'), { recursive: true });
    await symlink(outside, abs('pkg/src/main.js'));
    const ctx = makeCtx(tmp.dir, { packageDir: abs('pkg') });
    const res = await opToStep(browser).precheck(ctx);
    expect(res.kind).toBe('blocked');
    expect(await readFile(outside, 'utf8')).toBe('run();\n');
  });

  it('a failed run rolls the edit back through the shared runner, and a dry run writes nothing', async () => {
    await put('src/main.js', MAIN);
    const recipe: Recipe = {
      schema: 1,
      id: 'x',
      kind: 'runtime',
      platform: 'javascript-browser',
      engine: { min: '0.0.0' },
      sdk: { range: '*' },
      detect: [],
      ops: [browser, { op: 'write-env-var', file: 'a/../../escape', key: 'K', from: 'token' }],
    };
    const dry = await executeRecipe(
      { ...recipe, ops: [browser] },
      makeCtx(tmp.dir, { dryRun: true }),
    );
    expect(dry.results.map((r) => r.outcome)).toEqual(['planned']);
    expect(await read('src/main.js')).toBe(MAIN);
    const run = await executeRecipe(recipe, makeCtx(tmp.dir));
    expect(run.failed).toBe(true);
    expect(await read('src/main.js')).toBe(MAIN);
  });

  it('uninstall removes exactly the wizard lines and keeps the user edits made since', async () => {
    await put('src/main.js', MAIN);
    const recorder = createManifestRecorder(
      tmp.dir,
      { wizard: 't', recipes: [] },
      { cwd: tmp.dir },
    );
    const ctx = makeCtx(tmp.dir, { manifest: recorder });
    await opToStep(browser).apply(ctx);
    await recorder.flush();
    await put('src/main.js', `${await read('src/main.js')}console.log('mine');\n`);
    const log = ctx.log;
    const res = await rollbackFromManifest({ dir: tmp.dir, log, dryRun: false });
    expect(res.failed).toBe(false);
    expect(await read('src/main.js')).toBe(`${MAIN}console.log('mine');\n`);
  });

  it('uninstall restores the file byte for byte when it was not touched since', async () => {
    await put('src/main.js', MAIN);
    const recorder = createManifestRecorder(
      tmp.dir,
      { wizard: 't', recipes: [] },
      { cwd: tmp.dir },
    );
    await opToStep(browser).apply(makeCtx(tmp.dir, { manifest: recorder }));
    await recorder.flush();
    await rollbackFromManifest({ dir: tmp.dir, log: makeCtx(tmp.dir).log, dryRun: false });
    expect(await read('src/main.js')).toBe(MAIN);
  });
});

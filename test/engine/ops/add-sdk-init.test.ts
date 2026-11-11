import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
    expect(after).toContain("launch('tok_SECRET_123').catch(() => {}); // bugsee-wizard");
    expect(ctx.entries).toEqual([
      {
        file: 'src/main.js',
        action: 'edited',
        before: MAIN,
        after,
        marker: 'bugsee-wizard:sdk-init',
      },
    ]);
    expect(ctx.logs.join('\n')).not.toContain('tok_SECRET');
    expect((await step.precheck(ctx)).kind).toBe('satisfied');
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
    expect(after).toContain(`launch(import.meta.env['VITE_BUGSEE_APP_TOKEN']).catch(() => {});`);
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
    expect(cjs).toContain(`launch(process.env['BUGSEE_APP_TOKEN']);`);

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
    expect(out).toContain(
      `if (process.env['BUGSEE_APP_TOKEN']) launch(process.env['BUGSEE_APP_TOKEN']);`,
    );
  });

  it('is satisfied, and changes nothing, when the user already integrated a Bugsee package', async () => {
    const mine = "import { launch } from '@bugsee/bugsee';\nlaunch('x');\n";
    await put('src/main.js', mine);
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(browser);
    expect((await step.precheck(ctx)).kind).toBe('satisfied');
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

  it('an integration elsewhere in the project (the app launches from its own module) is left alone', async () => {
    await put('index.html', '<script type="module" src="/src/main.js"></script>');
    await put('src/main.js', "import './bugsee';\nrun();\n");
    await put(
      'src/bugsee.js',
      "import { launch } from '@bugsee/bugsee';\nlaunch('app-token', { appVersion: '1' });\n",
    );
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(browser);
    const res = await step.precheck(ctx);
    expect(res).toEqual({ kind: 'satisfied', note: expect.stringContaining('src/bugsee.js') });
    await step.apply(ctx);
    expect(await read('src/main.js')).toBe("import './bugsee';\nrun();\n");
    expect(ctx.entries).toEqual([]);
  });

  it('a runtime package other than the one being installed counts too (a dependency on @bugsee/node)', async () => {
    await put('package.json', JSON.stringify({ dependencies: { '@bugsee/node': '1' } }));
    await put('index.ts', 'run();\n');
    const res = await opToStep({ ...node, runtime: 'node' }).precheck(makeCtx(tmp.dir));
    expect(res).toEqual({ kind: 'satisfied', note: expect.stringContaining('@bugsee/node') });
  });

  it('the SDK package the recipe itself installed does not count as an integration', async () => {
    await put('package.json', JSON.stringify({ dependencies: { '@bugsee/bugsee': '1' } }));
    await put('index.ts', 'run();\n');
    expect((await opToStep(node).precheck(makeCtx(tmp.dir))).kind).toBe('pending');
  });

  it('no entry found: a Node/Bun snippet shows both module systems, a browser one only ESM', async () => {
    const nodeRes = await opToStep(node).apply(makeCtx(tmp.dir));
    const code = nodeRes?.manual?.code ?? '';
    expect(code).toContain("import { launch } from '@bugsee/bugsee'");
    expect(code).toContain("const { launch } = require('@bugsee/bugsee')");
    expect(code).toMatch(/CommonJS/);
    expect(code).not.toMatch(/ as string/);
    const browserRes = await opToStep(browser).apply(makeCtx(tmp.dir));
    expect(browserRes?.manual?.code).not.toContain('require(');
  });

  it('generates the edit from the text it writes over, and records that text as the "before"', async () => {
    await put('src/main.js', MAIN);
    const ctx = makeCtx(tmp.dir);
    await opToStep(browser).apply(ctx);
    expect(ctx.entries[0]).toMatchObject({ before: MAIN, file: 'src/main.js' });
  });

  it('a project too big to scan is a manual snippet, never "not integrated" (no second launch is planned)', async () => {
    await put('index.html', '<script type="module" src="/src/main.js"></script>');
    await put('src/main.js', MAIN);
    await mkdir(abs('docs'), { recursive: true });
    await Promise.all(
      Array.from({ length: 3100 }, (_, i) =>
        writeFile(abs(`docs/f${i}.js`), `export const a${i} = 1;\n`),
      ),
    );
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(browser);
    expect((await step.precheck(ctx)).kind).toBe('pending');
    const res = await step.apply(ctx);
    expect(res?.manual?.code).toMatch(/too many source files/);
    expect(res?.manual?.code).not.toContain('tok_SECRET');
    expect(await read('src/main.js')).toBe(MAIN);
    expect(ctx.entries).toEqual([{ file: 'your entry file', action: 'manual' }]);
  });

  describe('Node needs something to load .env', () => {
    const SERVER = "import { createServer } from 'node:http';\ncreateServer().listen(0);\n";
    const nodePkg = (scripts: object = {}) =>
      put(
        'package.json',
        JSON.stringify({ type: 'module', scripts: { start: 'node server.js', ...scripts } }),
      );

    it('nothing loads it: the edit is kept but the step is a manual one with the exact instruction', async () => {
      await nodePkg();
      await put('server.js', SERVER);
      const ctx = makeCtx(tmp.dir);
      const step = opToStep(node);
      const res = await step.apply(ctx);
      expect(await read('server.js')).toContain("if (process.env['BUGSEE_APP_TOKEN'])");
      expect(res?.applied).toBe(true);
      expect(res?.manual?.file).toBe('package.json');
      expect(res?.manual?.code).toContain('node --env-file=.env server.js');
      expect(res?.manual?.code).toMatch(
        /Bugsee will not start until the token is provided to the process/,
      );
      expect(ctx.entries.map((e) => e.action)).toEqual(['edited', 'manual']);
      // the edit stays rollback-covered
      await step.rollback(ctx);
      expect(await read('server.js')).toBe(SERVER);
    });

    it.each([
      ['--env-file', { start: 'node --env-file=.env server.js' }],
      ['--env-file-if-exists', { start: 'node --env-file-if-exists=.env server.js' }],
      ['dotenv cli', { start: 'dotenv -e .env -- node server.js' }],
      ['dotenvx', { start: 'dotenvx run -- node server.js' }],
      ['-r dotenv/config', { start: 'node -r dotenv/config server.js' }],
    ])('a script that loads it (%s) is enough', async (_n, scripts) => {
      await nodePkg(scripts);
      await put('server.js', SERVER);
      const res = await opToStep(node).apply(makeCtx(tmp.dir));
      expect(res).toBeUndefined();
    });

    it.each([
      ["import 'dotenv/config';\n"],
      ["import dotenv from 'dotenv';\ndotenv.config();\n"],
      ["require('dotenv').config();\n"],
      ['process.loadEnvFile();\n'],
    ])('code in the entry that loads it is enough: %s', async (load) => {
      await nodePkg();
      await put('server.js', `${load}${SERVER}`);
      const res = await opToStep(node).apply(makeCtx(tmp.dir));
      expect(res).toBeUndefined();
    });

    it('a re-run is still pending while nothing loads it (no second edit)', async () => {
      await nodePkg();
      await put('server.js', SERVER);
      const step = opToStep(node);
      await step.apply(makeCtx(tmp.dir));
      const after = await read('server.js');
      const ctx = makeCtx(tmp.dir);
      expect((await step.precheck(ctx)).kind).toBe('pending');
      const res = await step.apply(ctx);
      expect(res?.manual?.code).toContain('--env-file=.env');
      expect(res?.applied).toBeUndefined();
      expect(await read('server.js')).toBe(after);
    });

    it('Bun loads .env itself, and a literal token needs no loader', async () => {
      await put('package.json', JSON.stringify({ type: 'module' }));
      await put('index.ts', 'run();\n');
      expect(await opToStep(bun).apply(makeCtx(tmp.dir))).toBeUndefined();
      await put('server.js', SERVER);
      await nodePkg();
      const literal: Spec = { op: 'add-sdk-init', runtime: 'node', importFrom: '@bugsee/bugsee' };
      expect(await opToStep(literal).apply(makeCtx(tmp.dir))).toBeUndefined();
    });
  });

  describe('what counts as loading .env (review follow-ups)', () => {
    const SERVER = "import { createServer } from 'node:http';\ncreateServer().listen(0);\n";
    const setup = async (scripts: object, entry = SERVER, extra: Record<string, string> = {}) => {
      await put('package.json', JSON.stringify({ type: 'module', scripts }));
      await put('server.js', entry);
      for (const [f, c] of Object.entries(extra)) await put(f, c);
    };
    const run = (ctxOver = {}) => opToStep(node).apply(makeCtx(tmp.dir, ctxOver));

    it('only the scripts that start the app count: a dotenv mention in "test" does not silence the warning', async () => {
      await setup({ start: 'node server.js', test: 'jest --setupFiles dotenv/config' });
      expect((await run())?.manual?.title).toBe('Give Node the Bugsee token');
    });

    it.each([['start'], ['dev'], ['serve'], ['start:prod'], ['dev:watch']])(
      'a loader in the %s script counts',
      async (name) => {
        await setup({ [name]: 'node --env-file=.env server.js' });
        expect(await run()).toBeUndefined();
      },
    );

    it('follows one level of relative imports of the entry (a config module that loads dotenv)', async () => {
      await setup({ start: 'node server.js' }, "import './config.js';\n" + SERVER, {
        'config.js': "import 'dotenv/config';\n",
      });
      expect(await run()).toBeUndefined();
      await setup({ start: 'node server.js' }, "import { c } from './lib/config';\n" + SERVER, {
        'lib/config.js': "import dotenv from 'dotenv';\ndotenv.config();\nexport const c = 1;\n",
      });
      expect(await run()).toBeUndefined();
    });

    it('does not follow package imports or go deeper than one level', async () => {
      await setup({ start: 'node server.js' }, "import './a.js';\n" + SERVER, {
        'a.js': "import './b.js';\n",
        'b.js': "import 'dotenv/config';\n",
      });
      expect((await run())?.manual?.title).toBe('Give Node the Bugsee token');
    });

    it('@nestjs/config (ConfigModule loads .env) counts', async () => {
      await put(
        'package.json',
        JSON.stringify({
          type: 'module',
          dependencies: { '@nestjs/config': '3' },
          scripts: { start: 'node server.js' },
        }),
      );
      await put('server.js', SERVER);
      expect(await run()).toBeUndefined();
    });

    it.each([
      ['Dockerfile', 'ENV BUGSEE_APP_TOKEN=abc\n'],
      ['docker-compose.yml', 'services:\n  app:\n    environment:\n      - BUGSEE_APP_TOKEN=abc\n'],
      ['compose.yaml', 'services:\n  app:\n    env_file: .env\n'],
      ['Procfile', 'web: node --env-file=.env server.js\n'],
      [
        'ecosystem.config.cjs',
        'module.exports = { apps: [{ env: { BUGSEE_APP_TOKEN: "x" } }] };\n',
      ],
      ['fly.toml', '[env]\n  BUGSEE_APP_TOKEN = "x"\n'],
    ])('a platform file that provides the variable (%s) counts', async (file, text) => {
      await setup({ start: 'node server.js' }, SERVER, { [file]: text });
      expect(await run()).toBeUndefined();
    });

    it('--env-provided acknowledges it explicitly', async () => {
      await setup({ start: 'node server.js' });
      expect(await run({ envProvided: true })).toBeUndefined();
    });

    it('the snippet names a runnable command: built output or a generic form for TypeScript, the file otherwise', async () => {
      await put(
        'package.json',
        JSON.stringify({ type: 'module', scripts: { start: 'node server.js' } }),
      );
      await put('server.js', SERVER);
      expect((await run())?.manual?.code).toContain('node --env-file=.env server.js');
      await put('package.json', JSON.stringify({ type: 'module', main: 'dist/main.js' }));
      await put('src/main.ts', SERVER);
      await rm(abs('server.js'));
      const res = await run();
      expect(res?.manual?.code).not.toContain('src/main.ts');
      expect(res?.manual?.code).toMatch(/<your start command>|dist\/main\.js/);
    });
  });

  describe('start script and imports (review round 5)', () => {
    const SERVER = "import { createServer } from 'node:http';\ncreateServer().listen(0);\n";
    const run = () => opToStep(node).apply(makeCtx(tmp.dir));

    it('the start script decides: a loader in dev does not cover `npm start`', async () => {
      await put(
        'package.json',
        JSON.stringify({
          type: 'module',
          scripts: { start: 'node server.js', dev: 'node --env-file=.env server.js' },
        }),
      );
      await put('server.js', SERVER);
      expect((await run())?.manual?.title).toBe('Give Node the Bugsee token');
    });

    it('without a start script, dev or serve count', async () => {
      await put(
        'package.json',
        JSON.stringify({ type: 'module', scripts: { dev: 'node --env-file=.env server.js' } }),
      );
      await put('server.js', SERVER);
      expect(await run()).toBeUndefined();
    });

    it('a NodeNext-style `./env.js` import finds env.ts', async () => {
      await put(
        'package.json',
        JSON.stringify({ type: 'module', scripts: { start: 'node dist/index.js' } }),
      );
      await put('src/index.ts', "import './env.js';\n" + SERVER);
      await put('src/env.ts', "import 'dotenv/config';\n");
      expect(await run()).toBeUndefined();
    });
  });
});

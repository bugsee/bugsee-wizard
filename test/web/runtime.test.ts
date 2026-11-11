import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsDetection } from '../../src/web/detect.js';
import type { Prompts } from '../../src/web/prompts.js';
import { chooseRuntime } from '../../src/web/runtime.js';
import { makeTmp } from '../engine/helpers.js';
import { baseOpts } from './run-helpers.js';

const det = (over: Partial<JsDetection>): JsDetection => ({
  packageDir: '/p',
  packageManager: 'npm',
  runtimes: ['node'],
  typescript: false,
  versions: {},
  needsPackageChoice: false,
  ...over,
});
const prompts = (answer = 'node'): Prompts => ({
  confirm: vi.fn(async () => true),
  select: vi.fn(async () => answer),
});
const opts = baseOpts('/p');

describe('chooseRuntime', () => {
  it('a lone browser runtime: the browser recipe, or the Vite flavour with a Vite build', async () => {
    expect(
      await chooseRuntime(det({ runtimes: ['browser'], buildTool: 'webpack' }), opts, prompts()),
    ).toEqual({
      runtime: 'browser',
      platform: 'javascript-browser',
    });
    expect(
      await chooseRuntime(det({ runtimes: ['browser'], buildTool: 'vite' }), opts, prompts()),
    ).toEqual({
      runtime: 'browser',
      platform: 'javascript-browser-vite',
    });
  });

  it('a lone node runtime', async () => {
    expect(await chooseRuntime(det({ runtimes: ['node'] }), opts, prompts())).toEqual({
      runtime: 'node',
      platform: 'javascript-node',
    });
  });

  it('bun, alone or next to node (a server on Bun), is bun', async () => {
    for (const runtimes of [['bun'], ['node', 'bun']]) {
      expect(await chooseRuntime(det({ runtimes }), opts, prompts())).toEqual({
        runtime: 'bun',
        platform: 'javascript-bun',
      });
    }
  });

  it('browser next to bun only (bun is the package manager of a front end) is the browser', async () => {
    expect(
      await chooseRuntime(
        det({ runtimes: ['browser', 'bun'], buildTool: 'vite' }),
        opts,
        prompts(),
      ),
    ).toMatchObject({
      runtime: 'browser',
    });
  });

  it('a framework is skipped with a reason that names it, without asking anything', async () => {
    const p = prompts();
    const res = await chooseRuntime(
      det({ runtimes: ['browser', 'node'], framework: 'nextjs' }),
      opts,
      p,
    );
    expect(res).toEqual({ skip: expect.stringContaining('nextjs') });
    expect(p.select).not.toHaveBeenCalled();
  });

  it.each([['electron'], ['edge'], ['webworker'], ['serviceworker']])(
    'the %s runtime is not covered yet: skipped with its name',
    async (runtime) => {
      expect(await chooseRuntime(det({ runtimes: [runtime] }), opts, prompts())).toEqual({
        skip: expect.stringContaining(runtime),
      });
    },
  );

  it('a project that is browser and server: asks interactively, and uses the answer', async () => {
    const p = prompts('browser');
    const res = await chooseRuntime(
      det({ runtimes: ['browser', 'node'], buildTool: 'vite' }),
      baseOpts('/p', { nonInteractive: false }),
      p,
    );
    expect(res).toEqual({ runtime: 'browser', platform: 'javascript-browser-vite' });
    expect(p.select).toHaveBeenCalledWith(expect.stringMatching(/runtime/i), [
      { value: 'browser', label: expect.any(String) },
      { value: 'node', label: expect.any(String) },
    ]);
  });

  it('browser and server in a non-interactive run: skipped, never guessed', async () => {
    const p = prompts();
    const res = await chooseRuntime(det({ runtimes: ['browser', 'node'] }), opts, p);
    expect(res).toEqual({ skip: expect.stringMatching(/browser.*node|both/i) });
    expect(p.select).not.toHaveBeenCalled();
  });

  it('browser, node and bun together are offered all three', async () => {
    const p = prompts('bun');
    const res = await chooseRuntime(
      det({ runtimes: ['browser', 'node', 'bun'] }),
      baseOpts('/p', { nonInteractive: false }),
      p,
    );
    expect(res).toEqual({ runtime: 'bun', platform: 'javascript-bun' });
    expect(vi.mocked(p.select).mock.calls[0]?.[1].map((o) => o.value)).toEqual([
      'browser',
      'node',
      'bun',
    ]);
  });
});

describe('chooseRuntime (libraries)', () => {
  let tmp: Awaited<ReturnType<typeof makeTmp>>;
  beforeEach(async () => {
    tmp = await makeTmp();
  });
  afterEach(() => tmp.cleanup());
  const at = async (pkg: object) => {
    await mkdir(tmp.dir, { recursive: true });
    await writeFile(join(tmp.dir, 'package.json'), JSON.stringify(pkg));
    return chooseRuntime(det({ packageDir: tmp.dir, runtimes: ['node'] }), opts, prompts());
  };

  it('a package with an entry point and nothing that starts it is a library: skipped, with the reason', async () => {
    for (const pkg of [
      { main: 'dist/index.js' },
      { module: 'x.js' },
      { exports: './x.js' },
      { types: 'x.d.ts' },
      { peerDependencies: { react: '*' } },
      { exports: './x.js', scripts: { dev: 'tsc -w', build: 'tsc' } },
      { main: 'x.js', devDependencies: { express: '4' }, scripts: { test: 'vitest' } },
      { main: 'x.js', scripts: { dev: 'rollup -c -w' } },
    ]) {
      expect(await at(pkg)).toEqual({ skip: expect.stringMatching(/library/i) });
    }
  });

  it('a start/dev/serve script, a bin, or no entry point at all is an app', async () => {
    for (const pkg of [
      { main: 'a.js', scripts: { start: 'node a.js' } },
      { main: 'a.js', scripts: { serve: 'x' } },
      { main: 'a.js', bin: 'cli.js' },
      // the commonest tutorial shape: `npm init -y` + express
      { main: 'index.js', dependencies: { express: '4' } },
      { main: 'index.js', dependencies: { fastify: '4' }, scripts: { test: 'x' } },
      { main: 'index.js', scripts: { dev: 'nodemon index.js' } },
      { main: 'index.js', scripts: { dev: 'tsx watch src/server.ts' } },
      { main: 'index.js', scripts: { start: 'NODE_ENV=production node --env-file=.env index.js' } },
      {},
    ]) {
      expect(await at(pkg)).toEqual({ runtime: 'node', platform: 'javascript-node' });
    }
  });

  it('only Node and Bun are judged this way; an unreadable package.json is not a library', async () => {
    await writeFile(join(tmp.dir, 'package.json'), '{ nope');
    expect(
      await chooseRuntime(det({ packageDir: tmp.dir, runtimes: ['node'] }), opts, prompts()),
    ).toMatchObject({
      runtime: 'node',
    });
    await writeFile(join(tmp.dir, 'package.json'), JSON.stringify({ main: 'x.js' }));
    expect(
      await chooseRuntime(det({ packageDir: tmp.dir, runtimes: ['browser'] }), opts, prompts()),
    ).toMatchObject({ runtime: 'browser' });
  });

  it('a fresh `bun init` project (module entry, no scripts) is an app; for Node the module field still marks a library', async () => {
    await mkdir(tmp.dir, { recursive: true });
    await writeFile(
      join(tmp.dir, 'package.json'),
      JSON.stringify({ module: 'index.ts', type: 'module', private: true }),
    );
    expect(
      await chooseRuntime(det({ packageDir: tmp.dir, runtimes: ['bun'] }), opts, prompts()),
    ).toEqual({
      runtime: 'bun',
      platform: 'javascript-bun',
    });
    expect(
      await chooseRuntime(det({ packageDir: tmp.dir, runtimes: ['node'] }), opts, prompts()),
    ).toEqual({
      skip: expect.stringMatching(/library/i),
    });
  });
});

describe('chooseRuntime (unknown runtime, --runtime, Vite env)', () => {
  let tmp: Awaited<ReturnType<typeof makeTmp>>;
  beforeEach(async () => {
    tmp = await makeTmp();
  });
  afterEach(() => tmp.cleanup());
  const withFlag = (runtime: 'browser' | 'node' | 'bun' | 'none') => baseOpts('/p', { runtime });

  it('no runtime signal: skipped (never defaulted to node), pointing at --runtime', async () => {
    const res = await chooseRuntime(det({ runtimeUnknown: true }), opts, prompts());
    expect(res).toEqual({ skip: expect.stringContaining('--runtime') });
    expect('silent' in res).toBe(false);
  });

  it('--runtime picks the runtime whatever detection said (unknown, ambiguous, library)', async () => {
    expect(
      await chooseRuntime(det({ runtimeUnknown: true }), withFlag('browser'), prompts()),
    ).toEqual({
      runtime: 'browser',
      platform: 'javascript-browser',
    });
    expect(
      await chooseRuntime(det({ runtimes: ['browser', 'node'] }), withFlag('node'), prompts()),
    ).toEqual({ runtime: 'node', platform: 'javascript-node' });
    await writeFile(join(tmp.dir, 'package.json'), JSON.stringify({ main: 'x.js' }));
    expect(await chooseRuntime(det({ packageDir: tmp.dir }), withFlag('bun'), prompts())).toEqual({
      runtime: 'bun',
      platform: 'javascript-bun',
    });
    expect(
      await chooseRuntime(
        det({ runtimes: ['browser'], buildTool: 'vite' }),
        withFlag('browser'),
        prompts(),
      ),
    ).toEqual({ runtime: 'browser', platform: 'javascript-browser-vite' });
  });

  it('--runtime none is a silent, deliberate skip', async () => {
    expect(await chooseRuntime(det({}), withFlag('none'), prompts())).toEqual({
      skip: expect.stringContaining('--runtime none'),
      silent: true,
    });
  });

  it('a framework is skipped even with --runtime (that init is a later wave)', async () => {
    expect(await chooseRuntime(det({ framework: 'nextjs' }), withFlag('node'), prompts())).toEqual({
      skip: expect.stringContaining('nextjs'),
    });
  });

  it.each([['envDir: "../env"'], ["envPrefix: 'APP_'"], ["root: 'client'"]])(
    'a Vite config with %s keeps the token out of import.meta.env: literal-token recipe and a note',
    async (setting) => {
      await writeFile(join(tmp.dir, 'vite.config.ts'), `export default { ${setting} };\n`);
      const res = await chooseRuntime(
        det({ packageDir: tmp.dir, runtimes: ['browser'], buildTool: 'vite' }),
        opts,
        prompts(),
      );
      expect(res).toEqual({
        runtime: 'browser',
        platform: 'javascript-browser',
        note: expect.stringMatching(/envDir|envPrefix|root/),
      });
    },
  );

  it('an ordinary Vite config keeps the Vite recipe', async () => {
    await writeFile(join(tmp.dir, 'vite.config.ts'), 'export default { build: { rootDir: 1 } };\n');
    expect(
      await chooseRuntime(
        det({ packageDir: tmp.dir, runtimes: ['browser'], buildTool: 'vite' }),
        opts,
        prompts(),
      ),
    ).toEqual({ runtime: 'browser', platform: 'javascript-browser-vite' });
  });

  describe('no runtime signal in an interactive run asks, like an ambiguous one', () => {
    const interactive = baseOpts('/p', { nonInteractive: false });
    it('uses the answer', async () => {
      const p = prompts('node');
      expect(await chooseRuntime(det({ runtimeUnknown: true }), interactive, p)).toEqual({
        runtime: 'node',
        platform: 'javascript-node',
      });
      expect(vi.mocked(p.select).mock.calls[0]?.[1].map((o) => o.value)).toEqual([
        'browser',
        'node',
        'bun',
        'skip',
      ]);
    });
    it('"skip" is an unfinished step with the usual reason, never a guess', async () => {
      expect(
        await chooseRuntime(det({ runtimeUnknown: true }), interactive, prompts('skip')),
      ).toEqual({
        skip: expect.stringContaining('--runtime'),
      });
    });
    it('a non-interactive run does not ask', async () => {
      const p = prompts('node');
      await chooseRuntime(det({ runtimeUnknown: true }), opts, p);
      expect(p.select).not.toHaveBeenCalled();
    });
  });
});

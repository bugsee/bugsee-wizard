import { describe, expect, it, vi } from 'vitest';
import type { JsDetection } from '../../src/web/detect.js';
import type { Prompts } from '../../src/web/prompts.js';
import { chooseRuntime } from '../../src/web/runtime.js';
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

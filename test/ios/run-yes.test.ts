import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clack = vi.hoisted(() => ({
  note: vi.fn(),
  cancel: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  isCancel: (v: unknown) => v === Symbol.for('cancel'),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), error: vi.fn() }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), step: vi.fn() },
}));
vi.mock('@clack/prompts', () => clack);

const found = vi.hoisted(() => ({ paths: undefined as unknown }));
vi.mock('../../src/recipes/ios/paths.js', () => ({
  discoverIosPaths: async () => found.paths,
}));

import { runIosRecipe } from '../../src/recipes/ios/run.js';
import { cleanup, makeFixture, makeIosContext } from './helpers.js';

let dir: string;
const input = (over: Record<string, unknown> = {}) => ({
  cwd: dir,
  debug: false,
  dryRun: true,
  nonInteractive: false,
  json: false,
  ignoreGitChanges: false,
  yes: false,
  token: 'TOK',
  ...over,
});
const infos = () => clack.log.info.mock.calls.map((c) => String(c[0]));

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await makeFixture({ placeholder: '' });
  const ctx = makeIosContext({ cwd: dir, schemeName: 'App', podfilePath: null, dryRun: true });
  found.paths = {
    ...ctx.iosPaths,
    availableSchemes: [ctx.iosPaths.scheme, `${dir}/Other.xcscheme`],
    appDelegate: null,
  };
});
afterEach(() => cleanup(dir));

describe('runIosRecipe --yes', () => {
  it('takes every prompt default without asking: the detected scheme, SPM without a Podfile, no size analysis, no AppDelegate injection when none was found', async () => {
    await runIosRecipe(input({ yes: true }));
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(clack.text).not.toHaveBeenCalled();
    const chosen = infos().filter((m) => m.includes('(--yes)'));
    expect(chosen).toEqual([
      expect.stringContaining('Multiple schemes found'),
      expect.stringContaining('Distribution method for the Bugsee SDK Swift Package Manager'),
      expect.stringMatching(/size analysis\? No/),
      expect.stringMatching(/Auto-inject Bugsee\.launch.*No/),
    ]);
  });

  it('without --yes the same prompts are asked', async () => {
    clack.select.mockResolvedValueOnce((found.paths as { scheme: string }).scheme);
    clack.select.mockResolvedValueOnce('spm');
    clack.confirm.mockResolvedValue(false);
    await runIosRecipe(input());
    expect(clack.select).toHaveBeenCalledTimes(2);
    expect(clack.confirm).toHaveBeenCalledTimes(2);
    expect(infos().some((m) => m.includes('(--yes)'))).toBe(false);
  });
});

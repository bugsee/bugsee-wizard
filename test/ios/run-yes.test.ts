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

// these tests are about the questions and the notes, not the Xcode edits (steps have their own)
const steps = vi.hoisted(() => ({ ran: [] as string[] }));
vi.mock('../../src/core/step.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/step.js')>()),
  runSteps: async (list: readonly { id: string }[]) => {
    steps.ran = list.map((s) => s.id);
    return { failed: false, results: [] };
  },
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
  it('takes every prompt default without asking: the detected scheme, no size analysis, no AppDelegate injection when none was found', async () => {
    await runIosRecipe(input({ yes: true }));
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(clack.text).not.toHaveBeenCalled();
    const chosen = infos().filter((m) => m.includes('(--yes)'));
    expect(chosen).toEqual([
      expect.stringContaining('Multiple schemes found'),
      expect.stringMatching(/size analysis\? No/),
      expect.stringMatching(/Auto-inject Bugsee\.launch.*No/),
    ]);
  });

  it('without --yes the same prompts are asked', async () => {
    clack.select.mockResolvedValueOnce((found.paths as { scheme: string }).scheme);
    clack.confirm.mockResolvedValue(false);
    await runIosRecipe(input());
    expect(clack.select).toHaveBeenCalledTimes(1); // the scheme: no distribution question any more
    expect(clack.confirm).toHaveBeenCalledTimes(2);
    expect(infos().some((m) => m.includes('(--yes)'))).toBe(false);
  });
});

describe('runIosRecipe distribution (the SDK ships through SPM only since September 2026)', () => {
  const notes = () => clack.note.mock.calls.map((c) => String(c[0])).join('\n');
  const withPodfile = async () => {
    const ctx = makeIosContext({
      cwd: dir,
      schemeName: 'App',
      podfilePath: `${dir}/Podfile`,
      dryRun: true,
    });
    found.paths = { ...ctx.iosPaths, availableSchemes: [ctx.iosPaths.scheme], appDelegate: null };
  };

  it('never offers CocoaPods, even in a project that has a Podfile: SPM, no pod install', async () => {
    await withPodfile();
    clack.confirm.mockResolvedValue(false);
    expect(await runIosRecipe(input({ dryRun: false }))).toBe('ok');
    const asked = [...clack.select.mock.calls, ...clack.confirm.mock.calls].map((c) =>
      JSON.stringify(c[0]),
    );
    expect(asked.join('\n')).not.toMatch(/CocoaPods|pod install|Distribution/i);
    expect(notes()).toContain('SPM');
    expect(notes()).not.toContain('pod install');
  });

  it('--yes in a Podfile project takes SPM too', async () => {
    await withPodfile();
    await runIosRecipe(input({ yes: true, dryRun: false }));
    expect(clack.select).not.toHaveBeenCalled();
    expect(notes()).toContain('SPM');
    expect(notes()).not.toContain('pod install');
  });

  it('a parent recipe that still passes cocoapods keeps working (React Native, until it moves)', async () => {
    await withPodfile();
    clack.confirm.mockResolvedValue(false);
    await runIosRecipe(
      input({ dryRun: false, options: { distribution: 'cocoapods', runPodInstall: false } }),
    );
    expect(notes()).toContain('pod install');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clack = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  confirm: vi.fn(async () => true),
  select: vi.fn(),
  isCancel: (v: unknown) => v === Symbol.for('cancel'),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), step: vi.fn() },
}));
vi.mock('@clack/prompts', () => clack);

const recipes = vi.hoisted(() => ({
  runAndroidRecipe: vi.fn(),
  runIosRecipe: vi.fn(),
  runReactNativeRecipe: vi.fn(),
}));
vi.mock('../../src/recipes/android/run.js', () => ({ runAndroidRecipe: recipes.runAndroidRecipe }));
vi.mock('../../src/recipes/ios/run.js', () => ({ runIosRecipe: recipes.runIosRecipe }));
vi.mock('../../src/recipes/react-native/run.js', () => ({
  runReactNativeRecipe: recipes.runReactNativeRecipe,
}));

const web = vi.hoisted(() => ({ runJavaScriptInstall: vi.fn() }));
vi.mock('../../src/web/run.js', () => ({ runJavaScriptInstall: web.runJavaScriptInstall }));

const detectors = vi.hoisted(() => ({ detected: [] as unknown[] }));
vi.mock('../../src/core/detect.js', () => ({ runDetectors: async () => detectors.detected }));
vi.mock('../../src/detectors/index.js', () => ({ registerAllDetectors: () => {} }));

import { runInstall } from '../../src/commands/install.js';
import { CancelledError, MissingInputError } from '../../src/engine/noninteractive.js';

const opts = {
  cwd: '/x',
  debug: false,
  dryRun: false,
  nonInteractive: false,
  json: false,
  ignoreGitChanges: false,
  yes: false,
};
const outros = () => clack.outro.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  clack.confirm.mockResolvedValue(true);
});
afterEach(() => {
  process.exitCode = undefined;
});

describe.each([
  ['android', 'runAndroidRecipe'],
  ['ios', 'runIosRecipe'],
  ['react-native', 'runReactNativeRecipe'],
] as const)('runInstall (%s)', (kind, fn) => {
  beforeEach(() => {
    detectors.detected = [{ kind, confidence: 'high' }];
  });

  it('prints Done. and leaves the exit code alone on success', async () => {
    recipes[fn].mockResolvedValue('ok');
    await runInstall(opts);
    expect(outros()).toEqual(['Done.']);
    expect(process.exitCode).toBeUndefined();
  });

  it('prints a failure outro and exits 1 on failure', async () => {
    recipes[fn].mockResolvedValue('failed');
    await runInstall(opts);
    expect(outros()).not.toContain('Done.');
    expect(outros()[0]).toMatch(/not installed/i);
    expect(process.exitCode).toBe(1);
  });

  it('exits 0 without claiming success when the recipe was cancelled', async () => {
    // The recipe already printed its own "Cancelled." via clack.cancel.
    recipes[fn].mockResolvedValue('cancelled');
    await runInstall(opts);
    expect(outros()).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });
});

describe('runInstall (unsupported kind)', () => {
  it('does not claim success, and exits non-zero so a script can tell nothing was installed', async () => {
    detectors.detected = [{ kind: 'flutter', confidence: 'high' }];
    await runInstall(opts);
    expect(outros()).toEqual(['Nothing was installed.']);
    expect(process.exitCode).toBe(1);
  });
});

describe('runInstall --dry-run (javascript)', () => {
  it('ends with the same dry-run outro as the other flows, not "Done."', async () => {
    detectors.detected = [{ kind: 'javascript', confidence: 'high' }];
    web.runJavaScriptInstall.mockResolvedValue({ ok: true, incomplete: false, steps: [] });
    await runInstall({ ...opts, dryRun: true });
    expect(outros()).toEqual(['Dry run complete — no changes were made.']);
    expect(process.exitCode).toBeUndefined();
  });
});

describe('runInstall --dry-run', () => {
  it.each([
    ['android', 'runAndroidRecipe'],
    ['ios', 'runIosRecipe'],
    ['react-native', 'runReactNativeRecipe'],
  ] as const)('%s: says nothing was changed instead of "Done."', async (kind, fn) => {
    detectors.detected = [{ kind, confidence: 'high' }];
    recipes[fn].mockResolvedValue('ok');
    await runInstall({ ...opts, dryRun: true });
    expect(outros()).toEqual(['Dry run complete — no changes were made.']);
    expect(process.exitCode).toBeUndefined();
  });

  it('a failed dry run still reports the failure', async () => {
    detectors.detected = [{ kind: 'android', confidence: 'high' }];
    recipes.runAndroidRecipe.mockResolvedValue('failed');
    await runInstall({ ...opts, dryRun: true });
    expect(outros()[0]).toMatch(/not installed/i);
    expect(process.exitCode).toBe(1);
  });
});

describe('runInstall (javascript, interactive)', () => {
  beforeEach(() => {
    detectors.detected = [{ kind: 'javascript', confidence: 'high' }];
  });

  it('runs the JavaScript flow with the options and prints Done.', async () => {
    web.runJavaScriptInstall.mockResolvedValue({ ok: true, incomplete: false, steps: [] });
    await runInstall(opts);
    expect(web.runJavaScriptInstall).toHaveBeenCalledWith(opts);
    expect(outros()).toEqual(['Done.']);
    expect(process.exitCode).toBeUndefined();
  });

  it('incomplete: notes the manual steps, exit code stays 0', async () => {
    web.runJavaScriptInstall.mockResolvedValue({ ok: true, incomplete: true, steps: [] });
    await runInstall(opts);
    expect(clack.note).toHaveBeenCalledWith(expect.stringMatching(/manual/i), expect.any(String));
    expect(outros()[0]).toMatch(/manual/i);
    expect(process.exitCode).toBeUndefined();
  });

  it('failed: says so and exits 1', async () => {
    web.runJavaScriptInstall.mockResolvedValue({ ok: false, incomplete: false, steps: [] });
    await runInstall(opts);
    expect(outros()[0]).toMatch(/not installed/i);
    expect(process.exitCode).toBe(1);
  });

  it('cancelled: prints Cancelled. and exits 0', async () => {
    web.runJavaScriptInstall.mockRejectedValue(new CancelledError());
    await runInstall(opts);
    expect(clack.cancel).toHaveBeenCalledWith('Cancelled.');
    expect(outros()).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it('other errors propagate', async () => {
    web.runJavaScriptInstall.mockRejectedValue(new Error('boom'));
    await expect(runInstall(opts)).rejects.toThrow('boom');
  });
});

describe('runInstall (non-interactive kind choice)', () => {
  it('several detected kinds is MissingInputError(kind), with no prompt', async () => {
    detectors.detected = [
      { kind: 'android', confidence: 'high' },
      { kind: 'ios', confidence: 'high' },
    ];
    await expect(runInstall({ ...opts, nonInteractive: true })).rejects.toEqual(
      new MissingInputError('kind'),
    );
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.intro).not.toHaveBeenCalled();
  });
});

describe('runInstall --yes', () => {
  it('does not ask "Detected X. Continue?" and runs the recipe with yes passed on', async () => {
    detectors.detected = [{ kind: 'android', confidence: 'high' }];
    recipes.runAndroidRecipe.mockResolvedValue('ok');
    await runInstall({ ...opts, yes: true });
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(recipes.runAndroidRecipe).toHaveBeenCalledWith(expect.objectContaining({ yes: true }));
    expect(outros()).toEqual(['Done.']);
  });

  it('still asks what kind of project it is when detection is not confident: no default to take', async () => {
    detectors.detected = [];
    clack.select.mockResolvedValueOnce('android');
    recipes.runAndroidRecipe.mockResolvedValue('ok');
    await runInstall({ ...opts, yes: true });
    expect(clack.select).toHaveBeenCalledTimes(1);
  });
});

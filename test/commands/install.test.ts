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

const detectors = vi.hoisted(() => ({ detected: [] as unknown[] }));
vi.mock('../../src/core/detect.js', () => ({ runDetectors: async () => detectors.detected }));
vi.mock('../../src/detectors/index.js', () => ({ registerAllDetectors: () => {} }));

import { runInstall } from '../../src/commands/install.js';

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
  it('does not claim success', async () => {
    detectors.detected = [{ kind: 'flutter', confidence: 'high' }];
    await runInstall(opts);
    expect(outros()).not.toContain('Done.');
    expect(process.exitCode).toBeUndefined();
  });
});

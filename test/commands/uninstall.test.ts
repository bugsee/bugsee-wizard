import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clack = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  confirm: vi.fn(async () => true),
  select: vi.fn(async () => 'skip'),
  isCancel: (v: unknown) => v === Symbol.for('cancel'),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), step: vi.fn() },
}));
vi.mock('@clack/prompts', () => clack);

const rollbacks = vi.hoisted(() => ({
  runAndroidRollback: vi.fn(),
  runIosRollback: vi.fn(),
  runReactNativeRollback: vi.fn(),
}));
vi.mock('../../src/recipes/android/run.js', () => ({
  runAndroidRollback: rollbacks.runAndroidRollback,
}));
vi.mock('../../src/recipes/ios/run.js', () => ({ runIosRollback: rollbacks.runIosRollback }));
vi.mock('../../src/recipes/react-native/run.js', () => ({
  runReactNativeRollback: rollbacks.runReactNativeRollback,
}));

const detectors = vi.hoisted(() => ({ detected: [] as unknown[] }));
vi.mock('../../src/core/detect.js', () => ({ runDetectors: async () => detectors.detected }));
vi.mock('../../src/detectors/index.js', () => ({ registerAllDetectors: () => {} }));

import { runUninstall } from '../../src/commands/uninstall.js';

const opts = { cwd: '/x', debug: false, dryRun: false };
const outros = () => clack.outro.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  clack.confirm.mockResolvedValue(true);
  clack.select.mockResolvedValue('skip');
});
afterEach(() => {
  process.exitCode = undefined;
});

describe.each([
  ['android', 'runAndroidRollback'],
  ['ios', 'runIosRollback'],
  ['react-native', 'runReactNativeRollback'],
] as const)('runUninstall (%s)', (kind, fn) => {
  beforeEach(() => {
    detectors.detected = [{ kind, confidence: 'high' }];
  });

  it('prints Bugsee removed. on success', async () => {
    rollbacks[fn].mockResolvedValue('ok');
    await runUninstall(opts);
    expect(outros()).toEqual(['Bugsee removed.']);
    expect(process.exitCode).toBeUndefined();
  });

  it('reports failure, skips the exit poll and exits 1 when a rollback failed', async () => {
    rollbacks[fn].mockResolvedValue('failed');
    await runUninstall(opts);
    expect(outros()).not.toContain('Bugsee removed.');
    expect(outros()[0]).toMatch(/fail|error/i);
    expect(clack.select).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('says no rollback was performed when the project was not found', async () => {
    rollbacks[fn].mockResolvedValue('not-found');
    await runUninstall(opts);
    expect(outros()).toEqual(['No rollback was performed.']);
    expect(process.exitCode).toBeUndefined();
  });
});

describe('runUninstall (several platforms)', () => {
  it('fails overall when one platform fails and another succeeds', async () => {
    detectors.detected = [
      { kind: 'android', confidence: 'high' },
      { kind: 'ios', confidence: 'high' },
    ];
    clack.select.mockResolvedValueOnce('all' as never);
    rollbacks.runAndroidRollback.mockResolvedValue('ok');
    rollbacks.runIosRollback.mockResolvedValue('failed');
    await runUninstall(opts);
    expect(rollbacks.runAndroidRollback).toHaveBeenCalled();
    expect(outros()).not.toContain('Bugsee removed.');
    expect(process.exitCode).toBe(1);
  });
});

describe('runUninstall (dry run)', () => {
  it('reports a dry run instead of "Bugsee removed." and skips the exit poll', async () => {
    detectors.detected = [{ kind: 'android', confidence: 'high' }];
    rollbacks.runAndroidRollback.mockResolvedValue('ok');
    await runUninstall({ ...opts, dryRun: true });
    expect(outros()).toEqual(['Dry run complete — no changes were made.']);
    expect(clack.select).not.toHaveBeenCalled();
  });
});

describe('runUninstall (nothing detected)', () => {
  const tmp = () => mkdtempSync(path.join(tmpdir(), 'bugsee-un-'));
  beforeEach(() => {
    detectors.detected = [];
    rollbacks.runReactNativeRollback.mockResolvedValue('ok');
  });

  it('says nothing to uninstall when no indicators exist', async () => {
    const cwd = tmp();
    await runUninstall({ ...opts, cwd });
    expect(outros()[0]).toMatch(/Nothing to uninstall/);
    expect(rollbacks.runReactNativeRollback).not.toHaveBeenCalled();
  });

  it('ignores an unreadable/irrelevant package.json', async () => {
    const cwd = tmp();
    writeFileSync(path.join(cwd, 'package.json'), '{not json');
    await runUninstall({ ...opts, cwd });
    expect(rollbacks.runReactNativeRollback).not.toHaveBeenCalled();
  });

  it.each(['android', 'ios'])('offers the RN rollback when %s/ exists', async (dir) => {
    const cwd = tmp();
    mkdirSync(path.join(cwd, dir));
    await runUninstall({ ...opts, cwd });
    expect(rollbacks.runReactNativeRollback).toHaveBeenCalled();
    expect(outros()).toEqual(['Bugsee removed.']);
  });

  it('offers the RN rollback when package.json still has react-native-bugsee', async () => {
    const cwd = tmp();
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { 'react-native-bugsee': '^1' } }),
    );
    await runUninstall({ ...opts, cwd });
    expect(rollbacks.runReactNativeRollback).toHaveBeenCalled();
  });
});

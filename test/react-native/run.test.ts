import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const platform = vi.hoisted(() => ({
  runAndroidRecipe: vi.fn(),
  runIosRecipe: vi.fn(),
}));
vi.mock('../../src/recipes/android/run.js', () => ({
  runAndroidRecipe: platform.runAndroidRecipe,
  runAndroidRollback: vi.fn(async () => 'ok'),
}));
vi.mock('../../src/recipes/ios/run.js', () => ({
  runIosRecipe: platform.runIosRecipe,
  runIosRollback: vi.fn(async () => 'ok'),
}));

import { runReactNativeRecipe } from '../../src/recipes/react-native/run.js';
import {
  cleanup,
  makeFixture,
  readFixture,
  SAMPLE_APP_TSX,
  SAMPLE_RN_PACKAGE_JSON,
} from './helpers.js';

let fixture: string;
const opts = () => ({
  cwd: fixture,
  debug: false,
  dryRun: false,
  nonInteractive: false,
  json: false,
  ignoreGitChanges: false,
  yes: false,
});

beforeEach(async () => {
  vi.clearAllMocks();
  fixture = await makeFixture({
    'package.json': SAMPLE_RN_PACKAGE_JSON,
    'App.tsx': SAMPLE_APP_TSX,
    'android/.keep': '',
    'ios/.keep': '',
  });
  // Prompts: platforms=both, launch path=native.
  clack.select.mockResolvedValueOnce('both').mockResolvedValueOnce('native');
  clack.text.mockResolvedValue('TOKEN');
  // Prompts: auto-inject JS entry=yes, run package install=no.
  clack.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup(fixture);
});

describe('runReactNativeRecipe — native platform results', () => {
  it("returns 'ok' and keeps the RN-level edits when both platforms succeed", async () => {
    platform.runAndroidRecipe.mockResolvedValue('ok');
    platform.runIosRecipe.mockResolvedValue('ok');
    expect(await runReactNativeRecipe(opts())).toBe('ok');
    expect(await readFixture(fixture, 'package.json')).toContain('react-native-bugsee');
    expect(await readFixture(fixture, 'App.tsx')).toContain('Bugsee');
  });

  it('rolls the RN-level edits back and fails when iOS fails', async () => {
    platform.runAndroidRecipe.mockResolvedValue('ok');
    platform.runIosRecipe.mockResolvedValue('failed');
    expect(await runReactNativeRecipe(opts())).toBe('failed');
    expect(await readFixture(fixture, 'package.json')).toBe(SAMPLE_RN_PACKAGE_JSON);
    expect(await readFixture(fixture, 'App.tsx')).toBe(SAMPLE_APP_TSX);
    expect(clack.log.error).toHaveBeenCalledWith(expect.stringContaining('iOS setup failed'));
    // Android was configured before the failure and is reported as kept.
    expect(clack.log.warn).toHaveBeenCalledWith(expect.stringContaining('Android'));
    // No success summary.
    expect(clack.note).not.toHaveBeenCalledWith(expect.anything(), 'Done');
  });

  it('stops at the first failing platform and rolls back', async () => {
    platform.runAndroidRecipe.mockResolvedValue('failed');
    expect(await runReactNativeRecipe(opts())).toBe('failed');
    expect(platform.runIosRecipe).not.toHaveBeenCalled();
    expect(await readFixture(fixture, 'package.json')).toBe(SAMPLE_RN_PACKAGE_JSON);
    expect(clack.log.warn).not.toHaveBeenCalled();
  });

  it("returns 'cancelled' (and rolls back) when a platform recipe is cancelled", async () => {
    platform.runAndroidRecipe.mockResolvedValue('cancelled');
    expect(await runReactNativeRecipe(opts())).toBe('cancelled');
    expect(await readFixture(fixture, 'package.json')).toBe(SAMPLE_RN_PACKAGE_JSON);
  });
});

describe('runReactNativeRecipe --yes', () => {
  it('takes every prompt default (both platforms, native launch, inject, install) and still asks for tokens', async () => {
    clack.select.mockReset();
    clack.confirm.mockReset();
    // the default is to run the install when the manager is on PATH: a fake one, no network
    const bin = await mkdtemp(join(tmpdir(), 'rn-yes-bin-'));
    await writeFile(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    platform.runAndroidRecipe.mockResolvedValue('ok');
    platform.runIosRecipe.mockResolvedValue('ok');
    expect(await runReactNativeRecipe({ ...opts(), yes: true })).toBe('ok');
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(clack.text).toHaveBeenCalledTimes(2); // one token per platform: nothing to assume
    // the defaults: native launch (initialize), auto-inject because an entry file exists
    expect(await readFixture(fixture, 'App.tsx')).toContain('Bugsee');
    expect(platform.runAndroidRecipe).toHaveBeenCalledWith(
      expect.objectContaining({ yes: true, options: { initMode: 'automatic' } }),
    );
    expect(platform.runIosRecipe).toHaveBeenCalledWith(expect.objectContaining({ yes: true }));
  });
});

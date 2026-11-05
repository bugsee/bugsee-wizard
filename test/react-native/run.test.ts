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
const opts = () => ({ cwd: fixture, debug: false, dryRun: false });

beforeEach(async () => {
  vi.clearAllMocks();
  fixture = await makeFixture({
    'package.json': SAMPLE_RN_PACKAGE_JSON,
    'App.tsx': SAMPLE_APP_TSX,
    'android/.keep': '',
    'ios/App.xcodeproj/project.pbxproj': '',
  });
  // Prompts: platforms=both, launch path=native.
  clack.select.mockResolvedValueOnce('both').mockResolvedValueOnce('native');
  clack.text.mockResolvedValue('TOKEN');
  // Prompts: auto-inject JS entry=yes, run package install=no.
  clack.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
});
afterEach(async () => {
  await cleanup(fixture);
});

describe('runReactNativeRecipe — Android notes', () => {
  it('prints the multi-process provider snippet the Android recipe hands back in silent mode', async () => {
    platform.runAndroidRecipe.mockImplementation(async (input: { notes?: string[] }) => {
      input.notes?.push('Add inside <application> in AndroidManifest.xml: <provider … />');
      return 'ok';
    });
    platform.runIosRecipe.mockResolvedValue('ok');
    await runReactNativeRecipe(opts());
    const done = clack.note.mock.calls.find((c) => c[1] === 'Done')?.[0] as string;
    expect(done).toContain('Add inside <application> in AndroidManifest.xml');
  });
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

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

const web = vi.hoisted(() => ({ runJavaScriptUninstall: vi.fn() }));
vi.mock('../../src/web/uninstall.js', () => ({
  runJavaScriptUninstall: web.runJavaScriptUninstall,
}));

const detectors = vi.hoisted(() => ({ detected: [] as unknown[] }));
vi.mock('../../src/core/detect.js', () => ({ runDetectors: async () => detectors.detected }));
vi.mock('../../src/detectors/index.js', () => ({ registerAllDetectors: () => {} }));

import { runUninstall } from '../../src/commands/uninstall.js';
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

describe('runUninstall (javascript, interactive)', () => {
  beforeEach(() => {
    detectors.detected = [{ kind: 'javascript', confidence: 'high' }];
  });
  const removed = { ok: true, incomplete: false, steps: [{ id: 'a', outcome: 'reverted' }] };

  it('goes straight to the JavaScript flow (which lists and confirms), then the exit poll', async () => {
    web.runJavaScriptUninstall.mockResolvedValue(removed);
    await runUninstall(opts);
    expect(web.runJavaScriptUninstall).toHaveBeenCalledWith(opts);
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(clack.select).toHaveBeenCalledTimes(1);
    expect(outros()).toEqual(['Bugsee removed.']);
    expect(process.exitCode).toBeUndefined();
  });

  it('--dry-run: says nothing was changed, never "removed", no exit poll', async () => {
    web.runJavaScriptUninstall.mockResolvedValue(removed);
    await runUninstall({ ...opts, dryRun: true });
    expect(outros()).toEqual(['Dry run — nothing was changed.']);
    expect(clack.select).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('incomplete: lists what remains, never "removed", no exit poll', async () => {
    web.runJavaScriptUninstall.mockResolvedValue({
      ok: true,
      incomplete: true,
      steps: [
        { id: 'package.json', outcome: 'reverted' },
        { id: 'vite.config.ts', outcome: 'manual' },
      ],
    });
    await runUninstall(opts);
    expect(outros()).toHaveLength(1);
    expect(outros()[0]).toContain('vite.config.ts');
    expect(outros()[0]).not.toContain('package.json');
    expect(outros()[0]).not.toMatch(/Bugsee removed/);
    expect(clack.select).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('nothing to uninstall: no exit poll', async () => {
    web.runJavaScriptUninstall.mockResolvedValue({ ok: true, incomplete: false, steps: [] });
    await runUninstall(opts);
    expect(clack.select).not.toHaveBeenCalled();
    expect(outros()).toEqual(['No rollback was performed.']);
  });

  it('failed (e.g. an invalid manifest): exit 1, no exit poll', async () => {
    web.runJavaScriptUninstall.mockResolvedValue({
      ok: false,
      incomplete: false,
      steps: [],
      error: 'invalid-manifest',
    });
    await runUninstall(opts);
    expect(clack.select).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('cancelled: Cancelled., exit 0, no poll', async () => {
    web.runJavaScriptUninstall.mockRejectedValue(new CancelledError());
    await runUninstall(opts);
    expect(clack.cancel).toHaveBeenCalledWith('Cancelled.');
    expect(clack.select).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

describe('runUninstall (non-interactive)', () => {
  let stdout: string[];
  beforeEach(() => {
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      stdout.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const ni = { ...opts, nonInteractive: true, json: true, yes: true };

  it('javascript: one JSON object, never an exit poll or a prompt', async () => {
    detectors.detected = [{ kind: 'javascript', confidence: 'medium' }];
    web.runJavaScriptUninstall.mockResolvedValue({
      ok: true,
      incomplete: true,
      steps: [{ id: 'a', outcome: 'manual' }],
    });
    await runUninstall({ ...ni, nonInteractive: false });
    expect(web.runJavaScriptUninstall).toHaveBeenCalledWith(
      { ...ni, nonInteractive: true },
      expect.objectContaining({ output: expect.anything() }),
    );
    expect(JSON.parse(stdout.join(''))).toMatchObject({ ok: true, incomplete: true });
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(clack.intro).not.toHaveBeenCalled();
    expect(clack.outro).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('a native kind is unsupported: exit 1', async () => {
    detectors.detected = [{ kind: 'android', confidence: 'high' }];
    await runUninstall(ni);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      ok: false,
      error: 'unsupported-non-interactive',
      field: 'android',
    });
    expect(rollbacks.runAndroidRollback).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('nothing detected: nothing to uninstall, exit 0', async () => {
    detectors.detected = [];
    await runUninstall(ni);
    expect(JSON.parse(stdout.join(''))).toEqual({ ok: true, incomplete: false, steps: [] });
    expect(process.exitCode).toBe(0);
  });

  it('several kinds: MissingInputError(kind)', async () => {
    detectors.detected = [
      { kind: 'android', confidence: 'high' },
      { kind: 'ios', confidence: 'high' },
    ];
    await expect(runUninstall(ni)).rejects.toEqual(new MissingInputError('kind'));
  });
});

describe('runUninstall --yes', () => {
  const yes = { ...opts, yes: true };

  it('confirms the removal it was asked for without a question, and skips the exit poll', async () => {
    detectors.detected = [{ kind: 'android', confidence: 'high' }];
    rollbacks.runAndroidRollback.mockResolvedValue('ok');
    await runUninstall(yes);
    expect(clack.confirm).not.toHaveBeenCalled(); // the "Remove Bugsee from this project?" gate
    expect(rollbacks.runAndroidRollback).toHaveBeenCalledWith(yes);
    expect(clack.select).not.toHaveBeenCalled(); // no exit poll: a survey is not a confirmation
    expect(outros()).toEqual(['Bugsee removed.']);
  });

  it('with several platforms takes "all detected" without asking', async () => {
    detectors.detected = [
      { kind: 'android', confidence: 'high' },
      { kind: 'ios', confidence: 'high' },
    ];
    rollbacks.runAndroidRollback.mockResolvedValue('ok');
    rollbacks.runIosRollback.mockResolvedValue('ok');
    await runUninstall(yes);
    expect(clack.select).not.toHaveBeenCalled();
    expect(rollbacks.runAndroidRollback).toHaveBeenCalled();
    expect(rollbacks.runIosRollback).toHaveBeenCalled();
  });

  it('without --yes the removal is still asked, defaulting to no', async () => {
    detectors.detected = [{ kind: 'android', confidence: 'high' }];
    clack.confirm.mockResolvedValueOnce(false);
    await runUninstall(opts);
    expect(clack.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    expect(rollbacks.runAndroidRollback).not.toHaveBeenCalled();
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

  it.each([
    ['ios/App.xcodeproj/project.pbxproj', 'shellScript = "x # bugsee:wizard:rn-bundle:QQ==";'],
    [
      'ios/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme',
      '<Action>run_cli xcode post-action</Action>',
    ],
  ])('offers the RN rollback for the current recipe iOS edit in %s', async (file, text) => {
    const cwd = tmp();
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), text);
    await runUninstall({ ...opts, cwd });
    expect(rollbacks.runReactNativeRollback).toHaveBeenCalled();
  });

  it('native files without a wizard marker are not a Bugsee install', async () => {
    const cwd = tmp();
    mkdirSync(path.join(cwd, 'android'), { recursive: true });
    mkdirSync(path.join(cwd, 'ios'), { recursive: true });
    writeFileSync(
      path.join(cwd, 'android', 'build.gradle'),
      "apply plugin: 'com.android.library'\n",
    );
    writeFileSync(path.join(cwd, 'ios', 'Podfile'), "pod 'Alamofire'\n");
    await runUninstall({ ...opts, cwd });
    expect(rollbacks.runReactNativeRollback).not.toHaveBeenCalled();
    expect(outros()).toEqual(['No supported platform detected here. Nothing to uninstall.']);
  });

  it.each(['android', 'ios'])(
    'a bare %s/ directory is not a Bugsee install: says so, no rollback, no success message',
    async (dir) => {
      const cwd = tmp();
      mkdirSync(path.join(cwd, dir));
      await runUninstall({ ...opts, cwd });
      expect(rollbacks.runReactNativeRollback).not.toHaveBeenCalled();
      expect(outros()).toEqual(['No supported platform detected here. Nothing to uninstall.']);
      expect(outros()).not.toContain('Bugsee removed.');
      expect(process.exitCode).toBeUndefined();
    },
  );

  it.each([
    ['android', 'bugsee.properties', 'app_token=x\n'],
    ['android', 'build.gradle', "apply plugin: 'com.bugsee.android.gradle'\n"],
    ['android/app', 'build.gradle.kts', '// bugsee:wizard:bugsee-block:begin\n'],
    ['ios', 'Podfile', '# bugsee:wizard:pod\n'],
  ])('offers the RN rollback when %s/%s carries Bugsee leftovers', async (dir, file, text) => {
    const cwd = tmp();
    mkdirSync(path.join(cwd, dir), { recursive: true });
    writeFileSync(path.join(cwd, dir, file), text);
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

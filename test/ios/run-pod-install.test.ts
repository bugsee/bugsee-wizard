import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPodInstallStep } from '../../src/recipes/ios/steps/run-pod-install.js';
import { cleanup, makeFixture, makeIosContext } from './helpers.js';

vi.mock('@clack/prompts', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), error: vi.fn() }),
}));

// Mock the pod-on-PATH probe so we can drive the precheck branches
// independently of the test machine's environment.
let podAvailable = true;
vi.mock('../../src/recipes/ios/pod.js', () => ({
  isPodOnPath: () => podAvailable,
  _resetPodOnPathCache: () => {},
}));

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) {
    await cleanup(fixture);
    fixture = undefined;
  }
  podAvailable = true;
});

describe('runPodInstallStep — precheck branches', () => {
  it('is satisfied when distribution is SPM', async () => {
    fixture = await makeFixture({});
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'X',
      iosOptions: { distribution: 'spm', runPodInstall: true },
    });
    expect(await runPodInstallStep.precheck(ctx)).toEqual({
      kind: 'satisfied',
      note: 'CocoaPods not selected',
    });
  });

  it('is satisfied when the user did not opt in', async () => {
    fixture = await makeFixture({ Podfile: '# minimal\n' });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'X',
      podfilePath: `${fixture}/Podfile`,
      iosOptions: { distribution: 'cocoapods', runPodInstall: false },
    });
    expect(await runPodInstallStep.precheck(ctx)).toEqual({
      kind: 'satisfied',
      note: 'pod install not requested',
    });
  });

  it('blocks when no Podfile is present', async () => {
    fixture = await makeFixture({});
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'X',
      podfilePath: null,
      iosOptions: { distribution: 'cocoapods', runPodInstall: true },
    });
    const status = await runPodInstallStep.precheck(ctx);
    expect(status.kind).toBe('blocked');
  });

  it('blocks when `pod` is not on PATH', async () => {
    podAvailable = false;
    fixture = await makeFixture({ Podfile: '# minimal\n' });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'X',
      podfilePath: `${fixture}/Podfile`,
      iosOptions: { distribution: 'cocoapods', runPodInstall: true },
    });
    const status = await runPodInstallStep.precheck(ctx);
    expect(status.kind).toBe('blocked');
    if (status.kind === 'blocked') {
      expect(status.reason).toMatch(/pod/i);
    }
  });

  it('is pending when CocoaPods + opted in + pod available + Podfile present', async () => {
    fixture = await makeFixture({ Podfile: '# minimal\n' });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'X',
      podfilePath: `${fixture}/Podfile`,
      iosOptions: { distribution: 'cocoapods', runPodInstall: true },
    });
    expect(await runPodInstallStep.precheck(ctx)).toEqual({ kind: 'pending' });
  });
});

// Apply path is not unit-tested — it spawns the real `pod` binary, which
// requires a working CocoaPods install and a real Pods setup. Manual
// smoke-test against an iOS project fixture covers the happy path.

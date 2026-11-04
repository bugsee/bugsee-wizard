import { cp } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runIosRecipe, runIosRollback } from '../../src/recipes/ios/run.js';
import { addPodStep } from '../../src/recipes/ios/steps/add-pod.js';
import { addSchemePostActionStep } from '../../src/recipes/ios/steps/add-scheme-postaction.js';
import { addSpmDependencyStep } from '../../src/recipes/ios/steps/add-spm-dependency.js';
import { injectAppDelegateStep } from '../../src/recipes/ios/steps/inject-app-delegate.js';
import {
  cleanup,
  makeFixture,
  makeIosContext,
  readFixture,
  SAMPLE_APP_DELEGATE_SWIFT,
  SAMPLE_RN_PODFILE,
  SAMPLE_XCSCHEME,
} from './helpers.js';

vi.mock('@clack/prompts', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
  cancel: vi.fn(),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), error: vi.fn() }),
}));

const FIXTURE_PROJECT = path.resolve(__dirname, '../fixtures/ios/MinimalApp.xcodeproj');

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) {
    await cleanup(fixture);
    fixture = undefined;
  }
});

describe('iOS full rollback (install → uninstall round-trip)', () => {
  it('CocoaPods + AppDelegate inject: restores Podfile + AppDelegate + scheme', async () => {
    fixture = await makeFixture({
      Podfile: SAMPLE_RN_PODFILE,
      'MinimalApp/AppDelegate.swift': SAMPLE_APP_DELEGATE_SWIFT,
      'MinimalApp.xcodeproj/xcshareddata/xcschemes/MinimalApp.xcscheme': SAMPLE_XCSCHEME,
    });
    await cp(FIXTURE_PROJECT, path.join(fixture, 'MinimalApp.xcodeproj'), { recursive: true });
    // Also copy the scheme into the real .xcodeproj path discovery expects.
    await cp(
      path.join(fixture, 'MinimalApp.xcodeproj/xcshareddata/xcschemes/MinimalApp.xcscheme'),
      path.join(fixture, 'MinimalApp.xcodeproj/xcshareddata/xcschemes/MinimalApp.xcscheme'),
    ).catch(() => {});

    const originals = {
      podfile: await readFixture(fixture, 'Podfile'),
      appDelegate: await readFixture(fixture, 'MinimalApp/AppDelegate.swift'),
      scheme: await readFixture(
        fixture,
        'MinimalApp.xcodeproj/xcshareddata/xcschemes/MinimalApp.xcscheme',
      ),
    };

    // Apply the install steps that touch user files (CocoaPods path; skip
    // SPM step + pod-install spawn).
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'AwesomeProject',
      podfilePath: path.join(fixture, 'Podfile'),
      appDelegate: {
        path: path.join(fixture, 'MinimalApp/AppDelegate.swift'),
        language: 'swift',
      },
      iosOptions: {
        distribution: 'cocoapods',
        autoInjectAppDelegate: true,
        sizeAnalysis: true,
        sizeAnalysisAllConfigurations: true,
      },
      tokens: { ios: 'TOK' },
    });
    await addPodStep.apply(ctx);
    await injectAppDelegateStep.apply(ctx);

    // Scheme step needs a context whose scheme path points to MinimalApp.xcscheme;
    // use a separate ctx for that to keep semantics clean.
    const schemeCtx = makeIosContext({
      cwd: fixture,
      schemeName: 'MinimalApp',
      iosOptions: { distribution: 'cocoapods' },
      tokens: { ios: 'TOK' },
    });
    await addSchemePostActionStep.apply(schemeCtx);

    // Sanity — installs landed.
    expect(await readFixture(fixture, 'Podfile')).toContain("pod 'Bugsee'");
    expect(await readFixture(fixture, 'MinimalApp/AppDelegate.swift')).toContain(
      'Bugsee.launch(token:',
    );
    expect(
      await readFixture(fixture, 'MinimalApp.xcodeproj/xcshareddata/xcschemes/MinimalApp.xcscheme'),
    ).toContain('Bugsee Symbolication');

    const ran = await runIosRollback({
      cwd: fixture,
      debug: false,
      dryRun: false,
      nonInteractive: false,
      json: false,
    });
    expect(ran).toBe('ok');

    // Files restored byte-for-byte.
    expect(await readFixture(fixture, 'Podfile')).toBe(originals.podfile);
    expect(await readFixture(fixture, 'MinimalApp/AppDelegate.swift')).toBe(originals.appDelegate);
    expect(
      await readFixture(fixture, 'MinimalApp.xcodeproj/xcshareddata/xcschemes/MinimalApp.xcscheme'),
    ).toBe(originals.scheme);
  });

  it('SPM rollback removes the dependency from .pbxproj', async () => {
    fixture = await makeFixture({
      'MinimalApp.xcodeproj/xcshareddata/xcschemes/MinimalApp.xcscheme': SAMPLE_XCSCHEME,
    });
    await cp(FIXTURE_PROJECT, path.join(fixture, 'MinimalApp.xcodeproj'), { recursive: true });

    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MinimalApp',
      iosOptions: { distribution: 'spm' },
      tokens: { ios: 'TOK' },
    });
    await addSpmDependencyStep.apply(ctx);
    expect(await addSpmDependencyStep.precheck(ctx)).toEqual({ kind: 'satisfied' });

    const ran = await runIosRollback({
      cwd: fixture,
      debug: false,
      dryRun: false,
      nonInteractive: false,
      json: false,
    });
    expect(ran).toBe('ok');

    expect(await addSpmDependencyStep.precheck(ctx)).toEqual({ kind: 'pending' });
  });

  it('returns not-found when no iOS project is found at cwd', async () => {
    fixture = await makeFixture({ 'README.md': '' });
    const ran = await runIosRollback({
      cwd: fixture,
      debug: false,
      dryRun: false,
      nonInteractive: false,
      json: false,
    });
    expect(ran).toBe('not-found');
  });
});

describe('runIosRecipe result', () => {
  const baseOptions = {
    sizeAnalysis: false,
    sizeAnalysisAllConfigurations: false,
    autoInjectAppDelegate: false,
    runPodInstall: false,
  };

  async function projectFixture(): Promise<string> {
    const dir = await makeFixture({
      'MinimalApp.xcodeproj/xcshareddata/xcschemes/MinimalApp.xcscheme': SAMPLE_XCSCHEME,
    });
    await cp(FIXTURE_PROJECT, path.join(dir, 'MinimalApp.xcodeproj'), { recursive: true });
    return dir;
  }

  it("returns 'failed' when a step is blocked (CocoaPods without a Podfile)", async () => {
    fixture = await projectFixture();
    const res = await runIosRecipe({
      cwd: fixture,
      debug: false,
      dryRun: false,
      nonInteractive: false,
      json: false,
      token: 'TOK',
      silent: true,
      options: { ...baseOptions, distribution: 'cocoapods' },
    });
    expect(res).toBe('failed');
  });

  it("returns 'ok' after a complete silent SPM install", async () => {
    fixture = await projectFixture();
    const res = await runIosRecipe({
      cwd: fixture,
      debug: false,
      dryRun: false,
      nonInteractive: false,
      json: false,
      token: 'TOK',
      silent: true,
      options: { ...baseOptions, distribution: 'spm' },
    });
    expect(res).toBe('ok');
  });

  it("returns 'failed' when no iOS project is found", async () => {
    fixture = await makeFixture({ 'README.md': '' });
    const res = await runIosRecipe({
      cwd: fixture,
      debug: false,
      dryRun: false,
      nonInteractive: false,
      json: false,
      token: 'T',
    });
    expect(res).toBe('failed');
  });
});

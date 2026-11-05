import { cp } from 'node:fs/promises';
import path from 'node:path';
import * as clack from '@clack/prompts';
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
  SAMPLE_SIMPLE_PODFILE,
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
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: () => false,
  text: vi.fn(async () => 'DISCOVERED_TOKEN'),
  // Accept the heuristic default every prompt offers.
  select: vi.fn(async (opts: { initialValue?: unknown; options: { value: unknown }[] }) =>
    opts.initialValue !== undefined ? opts.initialValue : opts.options[0]?.value,
  ),
  // Everything off except the AppDelegate inject (no `pod install`, no size analysis).
  confirm: vi.fn(async (opts: { message: string }) => /Auto-inject/.test(opts.message)),
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
      ignoreGitChanges: false,
      yes: false,
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
      ignoreGitChanges: false,
      yes: false,
    });
    expect(ran).toBe('ok');

    expect(await addSpmDependencyStep.precheck(ctx)).toEqual({ kind: 'pending' });
  });

  it('removes the scheme post-action from a non-default shared scheme, leaving others untouched', async () => {
    const rel = (n: string) => `MinimalApp.xcodeproj/xcshareddata/xcschemes/${n}.xcscheme`;
    fixture = await makeFixture({
      [rel('MinimalApp')]: SAMPLE_XCSCHEME,
      [rel('Other')]: SAMPLE_XCSCHEME,
    });
    await cp(FIXTURE_PROJECT, path.join(fixture, 'MinimalApp.xcodeproj'), {
      recursive: true,
      force: false,
    });
    const defaultBefore = await readFixture(fixture, rel('MinimalApp'));
    const otherCtx = makeIosContext({
      cwd: fixture,
      schemeName: 'Other',
      xcodeProjectName: 'MinimalApp',
      tokens: { ios: 'TOK' },
    });
    await addSchemePostActionStep.apply(otherCtx);
    expect(await readFixture(fixture, rel('Other'))).toContain('Bugsee Symbolication');

    const ran = await runIosRollback({
      cwd: fixture,
      debug: false,
      dryRun: false,
      nonInteractive: false,
      json: false,
      ignoreGitChanges: false,
      yes: false,
    });
    expect(ran).toBe('ok');
    expect(await readFixture(fixture, rel('Other'))).toBe(SAMPLE_XCSCHEME);
    expect(await readFixture(fixture, rel('MinimalApp'))).toBe(defaultBefore);
  });

  it('returns not-found when no iOS project is found at cwd', async () => {
    fixture = await makeFixture({ 'README.md': '' });
    const ran = await runIosRollback({
      cwd: fixture,
      debug: false,
      dryRun: false,
      nonInteractive: false,
      json: false,
      ignoreGitChanges: false,
      yes: false,
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
      ignoreGitChanges: false,
      yes: false,
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
      ignoreGitChanges: false,
      yes: false,
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
      ignoreGitChanges: false,
      yes: false,
      token: 'T',
    });
    expect(res).toBe('failed');
  });
});

const BASE_OPTS = {
  cwd: '',
  debug: false,
  dryRun: false,
  nonInteractive: false,
  json: false,
  ignoreGitChanges: false,
  yes: false,
};

describe('runIosRecipe through discovery (no hand-built context)', () => {
  const SCHEME_REL = 'MinimalApp.xcodeproj/xcshareddata/xcschemes/MinimalApp.xcscheme';
  const PODFILE = SAMPLE_SIMPLE_PODFILE.replace("'MyApp'", "'MinimalApp'");

  async function discoveredFixture(): Promise<string> {
    const dir = await makeFixture({
      Podfile: PODFILE,
      'MinimalApp/AppDelegate.swift': SAMPLE_APP_DELEGATE_SWIFT,
      [SCHEME_REL]: SAMPLE_XCSCHEME,
    });
    // Real pbxproj (target "MinimalApp"); the shared scheme above is kept.
    await cp(
      path.join(FIXTURE_PROJECT, 'project.pbxproj'),
      path.join(dir, 'MinimalApp.xcodeproj/project.pbxproj'),
    );
    return dir;
  }

  async function snapshot(dir: string): Promise<Record<string, string>> {
    const rels = [
      'Podfile',
      'MinimalApp/AppDelegate.swift',
      SCHEME_REL,
      'MinimalApp.xcodeproj/project.pbxproj',
    ];
    return Object.fromEntries(
      await Promise.all(rels.map(async (r) => [r, await readFixture(dir, r)])),
    );
  }

  it('CocoaPods: names derived from MinimalApp.xcscheme reach Podfile, scheme and AppDelegate; rollback is byte-exact', async () => {
    fixture = await discoveredFixture();
    const before = await snapshot(fixture);

    const res = await runIosRecipe({
      ...BASE_OPTS,
      cwd: fixture,
      options: { distribution: 'cocoapods' },
    });
    expect(res).toBe('ok');
    // The prompts really ran (token entered, not supplied).
    expect(vi.mocked(clack.text)).toHaveBeenCalled();

    const after = await snapshot(fixture);
    // Podfile: the pod landed inside the discovered target block.
    const podBlock = /target 'MinimalApp' do[\s\S]*?\n {2}pod 'Bugsee'/.exec(after.Podfile ?? '');
    expect(podBlock).not.toBeNull();
    // Scheme: post-action carries the prompted token.
    expect(after[SCHEME_REL]).toContain('Bugsee Symbolication');
    expect(after[SCHEME_REL]).toContain('DISCOVERED_TOKEN');
    // AppDelegate discovered via the target's sources and injected.
    expect(after['MinimalApp/AppDelegate.swift']).toContain(
      'Bugsee.launch(token: "DISCOVERED_TOKEN")',
    );
    // CocoaPods path leaves the pbxproj alone.
    expect(after['MinimalApp.xcodeproj/project.pbxproj']).toBe(
      before['MinimalApp.xcodeproj/project.pbxproj'],
    );

    expect(await runIosRollback({ ...BASE_OPTS, cwd: fixture })).toBe('ok');
    expect(await snapshot(fixture)).toEqual(before);
  });

  it('SPM: the discovered target name reaches the pbxproj edit; rollback is byte-exact', async () => {
    fixture = await discoveredFixture();
    const before = await snapshot(fixture);

    const res = await runIosRecipe({ ...BASE_OPTS, cwd: fixture });
    expect(res).toBe('ok');

    const after = await snapshot(fixture);
    expect(after['MinimalApp.xcodeproj/project.pbxproj']).not.toBe(
      before['MinimalApp.xcodeproj/project.pbxproj'],
    );
    expect(after['MinimalApp.xcodeproj/project.pbxproj']).toContain(
      'https://github.com/bugsee/spm',
    );
    expect(after.Podfile).toBe(before.Podfile);
    expect(after[SCHEME_REL]).toContain('Bugsee Symbolication');

    expect(await runIosRollback({ ...BASE_OPTS, cwd: fixture })).toBe('ok');
    expect(await snapshot(fixture)).toEqual(before);
  });
});

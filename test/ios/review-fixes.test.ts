import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as xcode from 'xcode';

import { iosDetector } from '../../src/detectors/ios.js';
import { discoverIosPaths } from '../../src/recipes/ios/paths.js';
import { runIosRollback } from '../../src/recipes/ios/run.js';
import { addPodStep } from '../../src/recipes/ios/steps/add-pod.js';
import { addSchemePostActionStep } from '../../src/recipes/ios/steps/add-scheme-postaction.js';
import { addSpmDependencyStep } from '../../src/recipes/ios/steps/add-spm-dependency.js';
import { injectAppDelegateStep } from '../../src/recipes/ios/steps/inject-app-delegate.js';
import { runPodInstallStep } from '../../src/recipes/ios/steps/run-pod-install.js';
import { XcodeProject } from '../../src/recipes/ios/xcode-project.js';
import {
  cleanup,
  makeFixture,
  makeIosContext,
  readFixture,
  SAMPLE_APP_DELEGATE_SWIFT,
  SAMPLE_SIMPLE_PODFILE,
  SAMPLE_XCSCHEME,
} from './helpers.js';

const info = vi.fn();
vi.mock('@clack/prompts', () => ({
  log: {
    info: (m: string) => info(m),
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
const SPM_URL = 'https://github.com/bugsee/spm';

let fixture: string | undefined;
afterEach(async () => {
  info.mockClear();
  if (fixture) {
    await cleanup(fixture);
    fixture = undefined;
  }
});

async function withProject(files: Record<string, string> = {}): Promise<string> {
  const dir = await makeFixture(files);
  await cp(FIXTURE_PROJECT, path.join(dir, 'MinimalApp.xcodeproj'), { recursive: true });
  return dir;
}

function parse(dir: string) {
  const p = xcode.project(path.join(dir, 'MinimalApp.xcodeproj/project.pbxproj'));
  p.parseSync();
  return p.hash.project.objects as unknown as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
}

const spmArgs = (productName = 'Bugsee', packageUrl = SPM_URL) => ({
  targetName: 'MinimalApp',
  packageUrl,
  productName,
  packageName: 'spm',
  requirement: { kind: 'upToNextMajorVersion' as const, version: '6.0.0' },
});

describe('T25/T46 xcodeproj discovery', () => {
  it('throws naming every candidate when several projects exist', async () => {
    fixture = await makeFixture({
      'A.xcodeproj/project.pbxproj': '//',
      'B.xcodeproj/project.pbxproj': '//',
    });
    await expect(discoverIosPaths(fixture)).rejects.toThrow(/A\.xcodeproj, B\.xcodeproj/);
  });

  it('skips a bundle without project.pbxproj (paths and detector)', async () => {
    fixture = await makeFixture({
      'A.xcodeproj/README': 'stale',
      'B.xcodeproj/project.pbxproj': '//',
      'B.xcodeproj/xcshareddata/xcschemes/B.xcscheme': SAMPLE_XCSCHEME,
    });
    expect((await discoverIosPaths(fixture)).xcodeProjectName).toBe('B');
    const det = await iosDetector.detect({ cwd: fixture });
    expect(det?.evidence[0]?.path).toBe('B.xcodeproj');
  });

  it('detector returns null when no candidate has a pbxproj', async () => {
    fixture = await makeFixture({ 'A.xcodeproj/README': 'stale' });
    expect(await iosDetector.detect({ cwd: fixture })).toBeNull();
  });
});

describe('T27 rollback without a shared scheme', () => {
  it('still cleans the Podfile and AppDelegate', async () => {
    fixture = await withProject({
      Podfile: SAMPLE_SIMPLE_PODFILE.replace('MyApp', 'MinimalApp'),
    });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MinimalApp',
      podfilePath: path.join(fixture, 'Podfile'),
      iosOptions: { distribution: 'cocoapods' },
    });
    await addPodStep.apply(ctx);
    expect(await readFixture(fixture, 'Podfile')).toContain("pod 'Bugsee'");
    expect(await runIosRollback({ cwd: fixture, debug: false, dryRun: false })).toBe('ok');
    expect(await readFixture(fixture, 'Podfile')).not.toContain("pod 'Bugsee'");
  });
});

describe('T50 target name from the scheme BlueprintName', () => {
  it('uses BlueprintName for the target while keeping schemeName', async () => {
    fixture = await withProject({
      'MinimalApp.xcodeproj/xcshareddata/xcschemes/Release-Scheme.xcscheme':
        SAMPLE_XCSCHEME.replace('MyApp', 'MinimalApp').replace(
          /BlueprintName = "MyApp"/,
          'BlueprintName = "MinimalApp"',
        ),
    });
    const paths = await discoverIosPaths(fixture);
    expect(paths.schemeName).toBe('Release-Scheme');
    expect(paths.targetName).toBe('MinimalApp');
  });

  it('falls back to the scheme name when BlueprintName is not a pbxproj target', async () => {
    fixture = await withProject({
      'MinimalApp.xcodeproj/xcshareddata/xcschemes/MinimalApp.xcscheme': SAMPLE_XCSCHEME, // MyApp
    });
    expect((await discoverIosPaths(fixture)).targetName).toBe('MinimalApp');
  });

  it('SPM and Podfile steps look up targetName, not schemeName', async () => {
    fixture = await withProject({
      Podfile: SAMPLE_SIMPLE_PODFILE.replace('MyApp', 'MinimalApp'),
    });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'Some Scheme',
      xcodeProjectName: 'MinimalApp',
      targetName: 'MinimalApp',
      podfilePath: path.join(fixture, 'Podfile'),
      iosOptions: { distribution: 'spm' },
    });
    expect(await addSpmDependencyStep.precheck(ctx)).toEqual({ kind: 'pending' });
    const podCtx = {
      ...ctx,
      iosOptions: { ...ctx.iosOptions, distribution: 'cocoapods' as const },
    };
    expect(await addPodStep.precheck(podCtx)).toEqual({ kind: 'pending' });
  });
});

describe('T26 AppDelegate chosen by target membership', () => {
  async function twoDelegates(): Promise<string> {
    const dir = await withProject({
      'Alpha/AppDelegate.swift': SAMPLE_APP_DELEGATE_SWIFT,
      'Zeta/AppDelegate.swift': SAMPLE_APP_DELEGATE_SWIFT,
      'MinimalApp.xcodeproj/xcshareddata/xcschemes/MinimalApp.xcscheme': SAMPLE_XCSCHEME.replace(
        /MyApp/g,
        'MinimalApp',
      ),
    });
    const pbx = path.join(dir, 'MinimalApp.xcodeproj/project.pbxproj');
    let t = await readFile(pbx, 'utf8');
    t = t
      .replace(
        '/* Begin PBXFileReference section */',
        `/* Begin PBXBuildFile section */
\t\t9999999999999999999999B1 /* AppDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = 9999999999999999999999A1 /* AppDelegate.swift */; };
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
\t\t9999999999999999999999A1 /* AppDelegate.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AppDelegate.swift; sourceTree = "<group>"; };`,
      )
      .replace(
        'children = (\n\t\t\t\tCCCCCCCCCCCCCCCCCCCCCCC2 /* Products */,',
        'children = (\n\t\t\t\t9999999999999999999999G1 /* Zeta */,\n\t\t\t\tCCCCCCCCCCCCCCCCCCCCCCC2 /* Products */,',
      )
      .replace(
        '/* Begin PBXGroup section */',
        `/* Begin PBXGroup section */
\t\t9999999999999999999999G1 /* Zeta */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t9999999999999999999999A1 /* AppDelegate.swift */,
\t\t\t);
\t\t\tpath = Zeta;
\t\t\tsourceTree = "<group>";
\t\t};`,
      )
      .replace(
        /(FFFFFFFFFFFFFFFFFFFFFFF1 \/\* Sources \*\/ = \{\s*isa = PBXSourcesBuildPhase;\s*buildActionMask = 2147483647;\s*files = \()/,
        '$1\n\t\t\t\t9999999999999999999999B1 /* AppDelegate.swift in Sources */,',
      );
    await writeFile(pbx, t);
    return dir;
  }

  it('resolves the sources of the target through the group tree', async () => {
    fixture = await twoDelegates();
    const files = new XcodeProject(path.join(fixture, 'MinimalApp.xcodeproj')).targetSourceFiles(
      'MinimalApp',
    );
    expect(files).toEqual([path.join(fixture, 'Zeta/AppDelegate.swift')]);
  });

  it('prefers the AppDelegate that belongs to the target', async () => {
    fixture = await twoDelegates();
    const paths = await discoverIosPaths(fixture);
    expect(paths.appDelegate).toBe(path.join(fixture, 'Zeta/AppDelegate.swift'));
  });

  it('falls back to the heuristic when the target lists no sources', async () => {
    fixture = await withProject({
      'Alpha/AppDelegate.swift': SAMPLE_APP_DELEGATE_SWIFT,
      'MinimalApp.xcodeproj/xcshareddata/xcschemes/MinimalApp.xcscheme': SAMPLE_XCSCHEME,
    });
    const paths = await discoverIosPaths(fixture);
    expect(paths.appDelegate).toBe(path.join(fixture, 'Alpha/AppDelegate.swift'));
  });
});

describe('T29 pod precheck scope', () => {
  const podfile = (body: string) => `target 'MyApp' do\n${body}\nend\n`;
  async function status(body: string) {
    fixture = await makeFixture({ Podfile: podfile(body) });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      podfilePath: path.join(fixture, 'Podfile'),
      iosOptions: { distribution: 'cocoapods' },
    });
    return addPodStep.precheck(ctx);
  }

  it('ignores a commented-out pod', async () => {
    expect(await status("  # pod 'Bugsee'")).toEqual({ kind: 'pending' });
  });
  it('ignores a pod that only a nested Tests target has', async () => {
    expect(await status("  target 'MyAppTests' do\n    pod 'Bugsee'\n  end")).toEqual({
      kind: 'pending',
    });
  });
  it('still sees a real pod in the app target (even beside a nested target)', async () => {
    expect(await status("  pod 'Bugsee'\n  target 'MyAppTests' do\n  end")).toEqual({
      kind: 'satisfied',
    });
  });
});

describe('T30/T31 scheme post-action scoping', () => {
  const SCHEME_REL = 'MinimalApp.xcodeproj/xcshareddata/xcschemes/MinimalApp.xcscheme';
  const ours = `<ExecutionAction ActionType="x"><ActionContent title = "Bugsee Symbolication" scriptText="x"></ActionContent></ExecutionAction>`;

  it('a Bugsee post-action under another action does not count', async () => {
    const scheme = SAMPLE_XCSCHEME.replace(
      '<ArchiveAction',
      `<TestAction><PostActions>${ours}</PostActions></TestAction>\n   <ArchiveAction`,
    );
    fixture = await makeFixture({ [SCHEME_REL]: scheme });
    const ctx = makeIosContext({ cwd: fixture, schemeName: 'MinimalApp' });
    expect(await addSchemePostActionStep.precheck(ctx)).toEqual({ kind: 'pending' });
  });

  it('is satisfied when ours is inside the ArchiveAction', async () => {
    const scheme = SAMPLE_XCSCHEME.replace(
      /<ArchiveAction([^>]*)>\s*<\/ArchiveAction>/,
      `<ArchiveAction$1><PostActions>${ours}</PostActions></ArchiveAction>`,
    );
    fixture = await makeFixture({ [SCHEME_REL]: scheme });
    const ctx = makeIosContext({ cwd: fixture, schemeName: 'MinimalApp' });
    expect(await addSchemePostActionStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('blocks when the scheme has no ArchiveAction', async () => {
    const scheme = SAMPLE_XCSCHEME.replace(/<ArchiveAction[\s\S]*<\/ArchiveAction>/, '');
    fixture = await makeFixture({ [SCHEME_REL]: scheme });
    const ctx = makeIosContext({ cwd: fixture, schemeName: 'MinimalApp' });
    const status = await addSchemePostActionStep.precheck(ctx);
    expect(status.kind).toBe('blocked');
  });
});

describe('T32 launch insertion with code on the brace line', () => {
  const oneLiner = `import UIKit

class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool { return true }
}
`;

  it('inserts inside the body and rolls back cleanly', async () => {
    fixture = await makeFixture({ 'AppDelegate.swift': oneLiner });
    const file = path.join(fixture, 'AppDelegate.swift');
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      appDelegate: { path: file, language: 'swift' },
      iosOptions: { autoInjectAppDelegate: true },
    });
    await injectAppDelegateStep.apply(ctx);
    const updated = await readFile(file, 'utf8');
    const launch = updated.indexOf('Bugsee.launch(');
    expect(launch).toBeGreaterThan(updated.indexOf('-> Bool {'));
    expect(launch).toBeLessThan(updated.indexOf('return true'));
    expect(updated.indexOf('func application')).toBeLessThan(launch);
    await injectAppDelegateStep.rollback(ctx);
    const rolled = await readFile(file, 'utf8');
    expect(rolled).not.toContain('Bugsee');
    expect(rolled.replace(/\s+/g, ' ')).toBe(oneLiner.replace(/\s+/g, ' '));
  });

  it('stays in the body when the brace is followed by trailing spaces', async () => {
    fixture = await makeFixture({
      'AppDelegate.swift': oneLiner.replace('{ return true }', '{   \n        return true\n    }'),
    });
    const file = path.join(fixture, 'AppDelegate.swift');
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      appDelegate: { path: file, language: 'swift' },
      iosOptions: { autoInjectAppDelegate: true },
    });
    await injectAppDelegateStep.apply(ctx);
    const updated = await readFile(file, 'utf8');
    expect(updated.indexOf('Bugsee.launch(')).toBeGreaterThan(updated.indexOf('-> Bool {'));
  });
});

describe('T33 pod install rollback note', () => {
  it('tells the user to run pod install when the Podfile still has our block', async () => {
    fixture = await withProject({ Podfile: SAMPLE_SIMPLE_PODFILE.replace('MyApp', 'MinimalApp') });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MinimalApp',
      podfilePath: path.join(fixture, 'Podfile'),
    });
    await runPodInstallStep.rollback(ctx);
    expect(info).not.toHaveBeenCalled();
    await addPodStep.apply(ctx);
    await runPodInstallStep.rollback(ctx);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('pod install'));
  });
});

describe('T34 package URL verification', () => {
  it('a same-named product from another package is not treated as ours', async () => {
    fixture = await withProject();
    const dir = path.join(fixture, 'MinimalApp.xcodeproj');
    const proj = new XcodeProject(dir);
    proj.addSpmDependency(spmArgs('Bugsee', 'https://example.com/fork/bugsee.git'));
    expect(proj.hasSpmProduct('MinimalApp', 'Bugsee')).toBe(true);
    expect(proj.hasSpmProduct('MinimalApp', 'Bugsee', SPM_URL)).toBe(false);
    await proj.save();
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MinimalApp',
      iosOptions: { distribution: 'spm' },
    });
    const status = await addSpmDependencyStep.precheck(ctx);
    expect(status.kind).toBe('blocked');
  });

  it('matches the expected URL ignoring .git, slash and case', async () => {
    fixture = await withProject();
    const proj = new XcodeProject(path.join(fixture, 'MinimalApp.xcodeproj'));
    proj.addSpmDependency(spmArgs('Bugsee', 'https://GitHub.com/bugsee/spm.git/'));
    expect(proj.hasSpmProduct('MinimalApp', 'Bugsee', SPM_URL)).toBe(true);
  });
});

describe('T39 SPM product is linked via a PBXBuildFile in the Frameworks phase', () => {
  it('adds the build file + phase entry and rollback removes both', async () => {
    fixture = await withProject();
    const dir = path.join(fixture, 'MinimalApp.xcodeproj');
    const proj = new XcodeProject(dir);
    proj.addSpmDependency(spmArgs());
    await proj.save();

    let objects = parse(fixture);
    const depUuid = Object.entries(objects.XCSwiftPackageProductDependency ?? {}).find(
      ([k]) => !k.endsWith('_comment'),
    )?.[0];
    const buildFile = Object.entries(objects.PBXBuildFile ?? {}).find(
      ([k, v]) => !k.endsWith('_comment') && v.productRef === depUuid,
    );
    expect(buildFile).toBeDefined();
    const frameworks = Object.values(objects.PBXFrameworksBuildPhase ?? {}).find(
      (v) => typeof v !== 'string',
    ) as unknown as { files: Array<{ value: string }> };
    expect(frameworks.files.map((f) => f.value)).toContain(buildFile?.[0]);

    const proj2 = new XcodeProject(dir);
    expect(proj2.removeSpmDependency('MinimalApp', 'Bugsee')).toBe(true);
    await proj2.save();
    objects = parse(fixture);
    const left = Object.entries(objects.PBXBuildFile ?? {}).filter(
      ([k]) => !k.endsWith('_comment'),
    );
    expect(left).toHaveLength(0);
    const fw = Object.values(objects.PBXFrameworksBuildPhase ?? {}).find(
      (v) => typeof v !== 'string',
    ) as unknown as { files: unknown[] };
    expect(fw.files).toHaveLength(0);
  });

  it('creates a Frameworks phase when the target has none', async () => {
    fixture = await withProject();
    const pbx = path.join(fixture, 'MinimalApp.xcodeproj/project.pbxproj');
    const t = (await readFile(pbx, 'utf8')).replace(
      '\t\t\t\tBBBBBBBBBBBBBBBBBBBBBBB1 /* Frameworks */,\n',
      '',
    );
    await writeFile(pbx, t);
    const proj = new XcodeProject(path.join(fixture, 'MinimalApp.xcodeproj'));
    proj.addSpmDependency(spmArgs());
    await proj.save();
    const objects = parse(fixture);
    const target = Object.values(objects.PBXNativeTarget ?? {}).find(
      (v) => typeof v !== 'string' && v.name === 'MinimalApp',
    ) as unknown as { buildPhases: Array<{ value: string }> };
    const phaseIds = target.buildPhases.map((p) => p.value);
    const created = Object.entries(objects.PBXFrameworksBuildPhase ?? {}).filter(
      ([k, v]) => !k.endsWith('_comment') && typeof v !== 'string' && phaseIds.includes(k),
    );
    expect(created).toHaveLength(1);
    const phase = created[0]?.[1] as unknown as { files: unknown[] } | undefined;
    expect(phase?.files).toHaveLength(1);
  });
});

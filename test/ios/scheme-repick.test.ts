import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as clack from '@clack/prompts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverIosPaths, withScheme } from '../../src/recipes/ios/paths.js';
import { runIosRecipe, runIosRollback } from '../../src/recipes/ios/run.js';
import {
  cleanup,
  makeFixture,
  readFixture,
  SAMPLE_APP_DELEGATE_SWIFT,
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
  // The multi-scheme prompt: always pick the "Other" scheme.
  select: vi.fn(async (opts: { options: { value: string; label: string }[] }) => {
    return opts.options.find((o) => o.label === 'Other')?.value;
  }),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), error: vi.fn() }),
}));

const FIXTURE_PROJECT = path.resolve(__dirname, '../fixtures/ios/MinimalApp.xcodeproj');
const SCHEMES = 'MinimalApp.xcodeproj/xcshareddata/xcschemes';
const SWIFTUI =
  'import SwiftUI\n@main\nstruct OtherApp: App { var body: some Scene { WindowGroup { Text("x") } } }\n';

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) await cleanup(fixture);
  fixture = undefined;
});

/**
 * Two targets: "MinimalApp" (default scheme; sources App/AppDelegate.swift)
 * and "Other" (scheme "Other"; sources Other/AppDelegate.swift when
 * `otherHasDelegate`, else Other/OtherApp.swift only).
 */
async function twoTargets(otherHasDelegate: boolean): Promise<string> {
  const otherFile = otherHasDelegate ? 'AppDelegate.swift' : 'OtherApp.swift';
  const scheme = (target: string) =>
    SAMPLE_XCSCHEME.replace(/MyApp/g, target).replace(
      /BlueprintName = "[^"]*"/,
      `BlueprintName = "${target}"`,
    );
  const dir = await makeFixture({
    'App/AppDelegate.swift': SAMPLE_APP_DELEGATE_SWIFT,
    [`Other/${otherFile}`]: otherHasDelegate ? SAMPLE_APP_DELEGATE_SWIFT : SWIFTUI,
    [`${SCHEMES}/MinimalApp.xcscheme`]: scheme('MinimalApp'),
    [`${SCHEMES}/Other.xcscheme`]: scheme('Other'),
  });
  await cp(FIXTURE_PROJECT, path.join(dir, 'MinimalApp.xcodeproj'), {
    recursive: true,
    force: false,
  });
  const pbx = path.join(dir, 'MinimalApp.xcodeproj/project.pbxproj');
  const ref = (id: string, file: string) =>
    `\t\t${id} /* ${file} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${file}; sourceTree = "<group>"; };`;
  const bf = (id: string, fid: string, file: string) =>
    `\t\t${id} /* ${file} in Sources */ = {isa = PBXBuildFile; fileRef = ${fid} /* ${file} */; };`;
  const group = (id: string, name: string, child: string, file: string) =>
    `\t\t${id} /* ${name} */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t${child} /* ${file} */,\n\t\t\t);\n\t\t\tpath = ${name};\n\t\t\tsourceTree = "<group>";\n\t\t};`;
  const t = (await readFile(pbx, 'utf8'))
    .replace(
      '/* Begin PBXFileReference section */',
      `/* Begin PBXBuildFile section */\n${bf('99999999999999999999B001', '99999999999999999999A001', 'AppDelegate.swift')}\n${bf('99999999999999999999B002', '99999999999999999999A002', otherFile)}\n/* End PBXBuildFile section */\n\n/* Begin PBXFileReference section */\n${ref('99999999999999999999A001', 'AppDelegate.swift')}\n${ref('99999999999999999999A002', otherFile)}`,
    )
    .replace(
      'children = (\n\t\t\t\tCCCCCCCCCCCCCCCCCCCCCCC2 /* Products */,',
      'children = (\n\t\t\t\t99999999999999999999C001 /* App */,\n\t\t\t\t99999999999999999999C002 /* Other */,\n\t\t\t\tCCCCCCCCCCCCCCCCCCCCCCC2 /* Products */,',
    )
    .replace(
      '/* Begin PBXGroup section */',
      `/* Begin PBXGroup section */\n${group('99999999999999999999C001', 'App', '99999999999999999999A001', 'AppDelegate.swift')}\n${group('99999999999999999999C002', 'Other', '99999999999999999999A002', otherFile)}`,
    )
    .replace(
      /(FFFFFFFFFFFFFFFFFFFFFFF1 \/\* Sources \*\/ = \{\s*isa = PBXSourcesBuildPhase;\s*buildActionMask = 2147483647;\s*files = \()/,
      '$1\n\t\t\t\t99999999999999999999B001 /* AppDelegate.swift in Sources */,',
    )
    .replace(
      '/* Begin PBXSourcesBuildPhase section */',
      `/* Begin PBXSourcesBuildPhase section */\n\t\t99999999999999999999F002 /* Sources */ = {\n\t\t\tisa = PBXSourcesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n\t\t\t\t99999999999999999999B002 /* ${otherFile} in Sources */,\n\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};`,
    )
    .replace(
      '/* Begin PBXNativeTarget section */',
      `/* Begin PBXNativeTarget section */\n\t\t99999999999999999999D002 /* Other */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tbuildConfigurationList = EEEEEEEEEEEEEEEEEEEEEE1;\n\t\t\tbuildPhases = (\n\t\t\t\t99999999999999999999F002 /* Sources */,\n\t\t\t);\n\t\t\tbuildRules = (\n\t\t\t);\n\t\t\tdependencies = (\n\t\t\t);\n\t\t\tname = Other;\n\t\t\tproductName = Other;\n\t\t\tproductType = "com.apple.product-type.application";\n\t\t};`,
    );
  await writeFile(pbx, t);
  return dir;
}

describe('withScheme', () => {
  it('normal case: re-picking the default scheme keeps its own AppDelegate', async () => {
    fixture = await twoTargets(true);
    const paths = await discoverIosPaths(fixture);
    expect(paths.schemeName).toBe('MinimalApp');
    expect(paths.appDelegate).toBe(path.join(fixture, 'App/AppDelegate.swift'));
    const again = await withScheme(paths, paths.scheme);
    expect(again).toEqual(paths);
  });

  it("other-target case: the new scheme's own AppDelegate replaces the previous one", async () => {
    fixture = await twoTargets(true);
    const paths = await discoverIosPaths(fixture);
    const picked = await withScheme(paths, path.join(fixture, SCHEMES, 'Other.xcscheme'));
    expect(picked.schemeName).toBe('Other');
    expect(picked.targetName).toBe('Other');
    expect(picked.appDelegate).toBe(path.join(fixture, 'Other/AppDelegate.swift'));
    expect(picked.appDelegateLanguage).toBe('swift');
  });

  it("null case: a target without an AppDelegate does not inherit the previous scheme's", async () => {
    fixture = await twoTargets(false);
    const paths = await discoverIosPaths(fixture);
    expect(paths.appDelegate).toBe(path.join(fixture, 'App/AppDelegate.swift'));
    const picked = await withScheme(paths, path.join(fixture, SCHEMES, 'Other.xcscheme'));
    expect(picked.targetName).toBe('Other');
    expect(picked.appDelegate).toBeNull();
    expect(picked.appDelegateLanguage).toBeNull();
  });
});

describe('recipe through the multi-scheme prompt', () => {
  const options = {
    distribution: 'spm' as const,
    sizeAnalysis: false,
    sizeAnalysisAllConfigurations: false,
    autoInjectAppDelegate: true,
    runPodInstall: false,
  };

  it("does not inject into the default target's AppDelegate when the picked target has none; prints the snippet", async () => {
    fixture = await twoTargets(false);
    const before = await readFixture(fixture, 'App/AppDelegate.swift');
    vi.mocked(clack.note).mockClear();
    const res = await runIosRecipe({
      cwd: fixture,
      debug: false,
      dryRun: false,
      nonInteractive: false,
      json: false,
      ignoreGitChanges: false,
      yes: false,
      token: 'TOK',
      options,
    });
    expect(res).toBe('ok');
    expect(await readFixture(fixture, 'App/AppDelegate.swift')).toBe(before);
    const notes = vi.mocked(clack.note).mock.calls.map((c) => String(c[0]));
    expect(notes.some((n) => n.includes('Add to your AppDelegate'))).toBe(true);
  });

  it("injects into the picked target's AppDelegate, and rollback strips it from there", async () => {
    fixture = await twoTargets(true);
    const appBefore = await readFixture(fixture, 'App/AppDelegate.swift');
    const otherBefore = await readFixture(fixture, 'Other/AppDelegate.swift');
    const res = await runIosRecipe({
      cwd: fixture,
      debug: false,
      dryRun: false,
      nonInteractive: false,
      json: false,
      ignoreGitChanges: false,
      yes: false,
      token: 'TOK',
      options,
    });
    expect(res).toBe('ok');
    expect(await readFixture(fixture, 'App/AppDelegate.swift')).toBe(appBefore);
    expect(await readFixture(fixture, 'Other/AppDelegate.swift')).toContain('Bugsee.launch');
    // Rollback discovers the DEFAULT scheme's AppDelegate only; it must still
    // clean the other target's.
    expect(
      await runIosRollback({
        cwd: fixture,
        debug: false,
        dryRun: false,
        nonInteractive: false,
        json: false,
        ignoreGitChanges: false,
        yes: false,
      }),
    ).toBe('ok');
    expect(await readFixture(fixture, 'Other/AppDelegate.swift')).toBe(otherBefore);
    expect(await readFixture(fixture, 'App/AppDelegate.swift')).toBe(appBefore);
  });
});

import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as clack from '@clack/prompts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverIosPaths } from '../../src/recipes/ios/paths.js';
import { runIosRecipe } from '../../src/recipes/ios/run.js';
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
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), error: vi.fn() }),
}));

const FIXTURE_PROJECT = path.resolve(__dirname, '../fixtures/ios/MinimalApp.xcodeproj');
const SWIFTUI_APP =
  'import SwiftUI\n\n@main\nstruct MinimalAppApp: App {\n  var body: some Scene { WindowGroup { Text("x") } }\n}\n';

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) await cleanup(fixture);
  fixture = undefined;
});

/**
 * Target "MinimalApp" lists `App/MinimalAppApp.swift` (no AppDelegate) in its
 * Sources phase; `Other/AppDelegate.swift` exists on disk but belongs to some
 * other target. With `explicitSources: false` the phase is left empty
 * (Xcode 16 synchronized folders).
 */
async function project(explicitSources: boolean): Promise<string> {
  const dir = await makeFixture({
    'App/MinimalAppApp.swift': SWIFTUI_APP,
    'Other/AppDelegate.swift': SAMPLE_APP_DELEGATE_SWIFT,
    'MinimalApp.xcodeproj/xcshareddata/xcschemes/MinimalApp.xcscheme': SAMPLE_XCSCHEME.replace(
      /MyApp/g,
      'MinimalApp',
    ),
  });
  await cp(FIXTURE_PROJECT, path.join(dir, 'MinimalApp.xcodeproj'), {
    recursive: true,
    force: false,
  });
  if (explicitSources) {
    const pbx = path.join(dir, 'MinimalApp.xcodeproj/project.pbxproj');
    const t = (await readFile(pbx, 'utf8'))
      .replace(
        '/* Begin PBXFileReference section */',
        `/* Begin PBXBuildFile section */
\t\t9999999999999999999999B1 /* MinimalAppApp.swift in Sources */ = {isa = PBXBuildFile; fileRef = 9999999999999999999999A1 /* MinimalAppApp.swift */; };
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
\t\t9999999999999999999999A1 /* MinimalAppApp.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = MinimalAppApp.swift; sourceTree = "<group>"; };`,
      )
      .replace(
        'children = (\n\t\t\t\tCCCCCCCCCCCCCCCCCCCCCCC2 /* Products */,',
        'children = (\n\t\t\t\t9999999999999999999999G1 /* App */,\n\t\t\t\tCCCCCCCCCCCCCCCCCCCCCCC2 /* Products */,',
      )
      .replace(
        '/* Begin PBXGroup section */',
        `/* Begin PBXGroup section */
\t\t9999999999999999999999G1 /* App */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t9999999999999999999999A1 /* MinimalAppApp.swift */,
\t\t\t);
\t\t\tpath = App;
\t\t\tsourceTree = "<group>";
\t\t};`,
      )
      .replace(
        /(FFFFFFFFFFFFFFFFFFFFFFF1 \/\* Sources \*\/ = \{\s*isa = PBXSourcesBuildPhase;\s*buildActionMask = 2147483647;\s*files = \()/,
        '$1\n\t\t\t\t9999999999999999999999B1 /* MinimalAppApp.swift in Sources */,',
      );
    await writeFile(pbx, t);
  }
  return dir;
}

describe('AppDelegate selection vs. target membership', () => {
  it("does not adopt another target's AppDelegate when this target lists sources without one", async () => {
    fixture = await project(true);
    const paths = await discoverIosPaths(fixture);
    expect(paths.appDelegate).toBeNull();
    expect(paths.appDelegateLanguage).toBeNull();
  });

  it('the recipe leaves the other AppDelegate alone and prints the snippet', async () => {
    fixture = await project(true);
    const before = await readFixture(fixture, 'Other/AppDelegate.swift');
    const res = await runIosRecipe({
      cwd: fixture,
      debug: false,
      dryRun: false,
      nonInteractive: false,
      json: false,
      ignoreGitChanges: false,
      yes: false,
      token: 'TOK',
      options: {
        distribution: 'spm',
        sizeAnalysis: false,
        sizeAnalysisAllConfigurations: false,
        autoInjectAppDelegate: true,
        runPodInstall: false,
      },
    });
    expect(res).toBe('ok');
    expect(await readFixture(fixture, 'Other/AppDelegate.swift')).toBe(before);
    const notes = vi.mocked(clack.note).mock.calls.map((c) => String(c[0]));
    expect(notes.some((n) => n.includes('Add to your AppDelegate'))).toBe(true);
  });

  it('still falls back to the heuristic when the target lists no sources (synchronized folders)', async () => {
    fixture = await project(false);
    const paths = await discoverIosPaths(fixture);
    expect(paths.appDelegate).toBe(path.join(fixture, 'Other/AppDelegate.swift'));
  });
});

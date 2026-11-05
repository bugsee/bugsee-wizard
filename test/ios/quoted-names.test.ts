import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverIosPaths } from '../../src/recipes/ios/paths.js';
import { runIosRecipe, runIosRollback } from '../../src/recipes/ios/run.js';
import { XcodeProject } from '../../src/recipes/ios/xcode-project.js';
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
const PBX = 'MinimalApp.xcodeproj/project.pbxproj';

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) await cleanup(fixture);
  fixture = undefined;
});

/**
 * A project whose only target (and its source group directory) has a name
 * that the pbxproj writer must quote, with an AppDelegate in the Sources phase.
 */
async function quotedProject(targetName: string): Promise<string> {
  const dir = await makeFixture({
    [`${targetName}/AppDelegate.swift`]: SAMPLE_APP_DELEGATE_SWIFT,
    // A second, non-member AppDelegate that discovery must NOT pick.
    'Alpha/AppDelegate.swift': SAMPLE_APP_DELEGATE_SWIFT,
    'MinimalApp.xcodeproj/xcshareddata/xcschemes/MinimalApp.xcscheme': SAMPLE_XCSCHEME.replace(
      /BlueprintName = "MyApp"/g,
      `BlueprintName = "${targetName}"`,
    ),
  });
  await cp(FIXTURE_PROJECT, path.join(dir, 'MinimalApp.xcodeproj'), {
    recursive: true,
    force: false,
  });
  const pbx = path.join(dir, PBX);
  const q = `"${targetName}"`;
  const t = (await readFile(pbx, 'utf8'))
    .replace('name = MinimalApp;', `name = ${q};`)
    .replace('productName = MinimalApp;', `productName = ${q};`)
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
      'children = (\n\t\t\t\t9999999999999999999999G1 /* group */,\n\t\t\t\tCCCCCCCCCCCCCCCCCCCCCCC2 /* Products */,',
    )
    .replace(
      '/* Begin PBXGroup section */',
      `/* Begin PBXGroup section */
\t\t9999999999999999999999G1 /* group */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t9999999999999999999999A1 /* AppDelegate.swift */,
\t\t\t);
\t\t\tpath = ${q};
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

describe.each(['My App', 'App-Staging'])(
  'pbxproj target named "%s" (quoted in the file)',
  (name) => {
    it('findNativeTarget / sources / SPM helpers find the quoted target', async () => {
      fixture = await quotedProject(name);
      const proj = new XcodeProject(path.join(fixture, 'MinimalApp.xcodeproj'));
      expect(proj.findNativeTarget(name)).not.toBeNull();
      expect(proj.targetSourceFiles(name)).toEqual([path.join(fixture, name, 'AppDelegate.swift')]);
      proj.addSpmDependency({
        targetName: name,
        packageUrl: 'https://github.com/bugsee/spm',
        productName: 'Bugsee',
        packageName: 'spm',
        requirement: { kind: 'upToNextMajorVersion', version: '6.0.0' },
      });
      expect(proj.hasSpmProduct(name, 'Bugsee')).toBe(true);
      expect(proj.removeSpmDependency(name, 'Bugsee')).toBe(true);
      expect(proj.hasSpmProduct(name, 'Bugsee')).toBe(false);
    });

    it('discovery resolves the quoted target and its AppDelegate', async () => {
      fixture = await quotedProject(name);
      const paths = await discoverIosPaths(fixture);
      expect(paths.targetName).toBe(name);
      expect(paths.appDelegate).toBe(path.join(fixture, name, 'AppDelegate.swift'));
    });

    it('SPM install through the recipe succeeds and rollback is byte-exact', async () => {
      fixture = await quotedProject(name);
      const files = [PBX, `${name}/AppDelegate.swift`];
      const before = await Promise.all(files.map((f) => readFixture(fixture as string, f)));
      const res = await runIosRecipe({
        cwd: fixture,
        debug: false,
        dryRun: false,
        token: 'TOK',
        silent: true,
        options: {
          distribution: 'spm',
          sizeAnalysis: false,
          sizeAnalysisAllConfigurations: false,
          autoInjectAppDelegate: true,
          runPodInstall: false,
        },
      });
      expect(res).toBe('ok');
      expect(await readFixture(fixture, PBX)).toContain('https://github.com/bugsee/spm');
      expect(await readFixture(fixture, `${name}/AppDelegate.swift`)).toContain('Bugsee.launch');
      expect(await runIosRollback({ cwd: fixture, debug: false, dryRun: false })).toBe('ok');
      const after = await Promise.all(files.map((f) => readFixture(fixture as string, f)));
      expect(after).toEqual(before);
    });
  },
);

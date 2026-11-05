import { cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as xcode from 'xcode';

import { addSpmDependencyStep } from '../../src/recipes/ios/steps/add-spm-dependency.js';
import { XcodeProject } from '../../src/recipes/ios/xcode-project.js';
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
}));

const FIXTURE_PROJECT = path.resolve(__dirname, '../fixtures/ios/MinimalApp.xcodeproj');
const TARGET_NAME = 'MinimalApp';

let fixture: string | undefined;

async function copyFixtureInto(dir: string): Promise<string> {
  const dest = path.join(dir, 'MinimalApp.xcodeproj');
  await cp(FIXTURE_PROJECT, dest, { recursive: true });
  return dest;
}

afterEach(async () => {
  if (fixture) {
    await cleanup(fixture);
    fixture = undefined;
  }
});

describe('XcodeProject helper', () => {
  beforeEach(async () => {
    fixture = await makeFixture({});
    await copyFixtureInto(fixture);
  });

  it('finds the native target by name', async () => {
    if (!fixture) throw new Error('fixture not set up');
    const proj = new XcodeProject(path.join(fixture, 'MinimalApp.xcodeproj'));
    const found = proj.findNativeTarget(TARGET_NAME);
    expect(found).not.toBeNull();
    expect(found?.target.name).toBe(TARGET_NAME);
  });

  it('hasSpmProduct returns false on a fresh project', async () => {
    if (!fixture) throw new Error('fixture not set up');
    const proj = new XcodeProject(path.join(fixture, 'MinimalApp.xcodeproj'));
    expect(proj.hasSpmProduct(TARGET_NAME, 'Bugsee')).toBe(false);
  });

  it('addSpmDependency adds package + product + project + target references', async () => {
    if (!fixture) throw new Error('fixture not set up');
    const proj = new XcodeProject(path.join(fixture, 'MinimalApp.xcodeproj'));
    proj.addSpmDependency({
      targetName: TARGET_NAME,
      packageUrl: 'https://github.com/bugsee/spm',
      productName: 'Bugsee',
      packageName: 'spm',
      requirement: { kind: 'upToNextMajorVersion', version: '6.0.0' },
    });
    await proj.save();

    // Re-parse from disk and verify.
    const reparsed = xcode.project(path.join(fixture, 'MinimalApp.xcodeproj/project.pbxproj'));
    reparsed.parseSync();
    const objects = reparsed.hash.project.objects as unknown as Record<
      string,
      Record<string, Record<string, unknown> | string>
    >;

    // 1. XCRemoteSwiftPackageReference section exists with exactly one ref pointing at our URL.
    const refSection = objects.XCRemoteSwiftPackageReference;
    expect(refSection).toBeDefined();
    if (!refSection) return;
    const refEntries = Object.entries(refSection).filter(
      ([k, v]) => !k.endsWith('_comment') && typeof v !== 'string',
    );
    expect(refEntries.length).toBe(1);
    const refRecord = refEntries[0]?.[1] as Record<string, unknown>;
    expect(refRecord.repositoryURL).toBe('"https://github.com/bugsee/spm"');
    expect(refRecord.requirement).toMatchObject({
      kind: 'upToNextMajorVersion',
      minimumVersion: '6.0.0',
    });

    // 2. XCSwiftPackageProductDependency section exists pointing at the Bugsee product.
    const depSection = objects.XCSwiftPackageProductDependency;
    expect(depSection).toBeDefined();
    if (!depSection) return;
    const depEntries = Object.entries(depSection).filter(
      ([k, v]) => !k.endsWith('_comment') && typeof v !== 'string',
    );
    expect(depEntries.length).toBe(1);
    const depRecord = depEntries[0]?.[1] as Record<string, unknown>;
    expect(depRecord.productName).toBe('Bugsee');

    // 3. The target's packageProductDependencies array references the product dep.
    const target = objects.PBXNativeTarget as Record<string, Record<string, unknown> | string>;
    const targetEntry = Object.values(target).find(
      (v) => typeof v !== 'string' && (v as Record<string, unknown>).name === TARGET_NAME,
    ) as Record<string, unknown>;
    const productDeps = targetEntry.packageProductDependencies as Array<{
      value: string;
      comment?: string;
    }>;
    expect(productDeps.some((d) => d.comment === 'Bugsee')).toBe(true);

    // 4. The PBXProject's packageReferences array contains the package ref.
    const projectSection = objects.PBXProject;
    if (!projectSection) throw new Error('PBXProject section missing');
    const projEntry = Object.values(projectSection).find(
      (v) => typeof v !== 'string' && (v as Record<string, unknown>).isa === 'PBXProject',
    ) as Record<string, unknown>;
    const pkgRefs = projEntry.packageReferences as Array<{ value: string; comment?: string }>;
    expect(pkgRefs.some((r) => r.comment?.includes('"spm"'))).toBe(true);
  });

  it('removeSpmDependency removes both target dep and orphaned package ref', async () => {
    if (!fixture) throw new Error('fixture not set up');
    const projPath = path.join(fixture, 'MinimalApp.xcodeproj');
    const proj = new XcodeProject(projPath);
    proj.addSpmDependency({
      targetName: TARGET_NAME,
      packageUrl: 'https://github.com/bugsee/spm',
      productName: 'Bugsee',
      packageName: 'spm',
      requirement: { kind: 'upToNextMajorVersion', version: '6.0.0' },
    });
    expect(proj.hasSpmProduct(TARGET_NAME, 'Bugsee')).toBe(true);
    const removed = proj.removeSpmDependency(TARGET_NAME, 'Bugsee');
    expect(removed).toBe(true);
    expect(proj.hasSpmProduct(TARGET_NAME, 'Bugsee')).toBe(false);
    await proj.save();

    // Re-parse from disk to confirm the orphaned package ref was dropped.
    const reparsed = xcode.project(path.join(projPath, 'project.pbxproj'));
    reparsed.parseSync();
    const objects = reparsed.hash.project.objects as unknown as Record<
      string,
      Record<string, Record<string, unknown> | string> | undefined
    >;
    const refSection = objects.XCRemoteSwiftPackageReference;
    if (refSection) {
      const refs = Object.entries(refSection).filter(
        ([k, v]) => !k.endsWith('_comment') && typeof v !== 'string',
      );
      expect(refs.length).toBe(0);
    }
    const depSection = objects.XCSwiftPackageProductDependency;
    if (depSection) {
      const deps = Object.entries(depSection).filter(
        ([k, v]) => !k.endsWith('_comment') && typeof v !== 'string',
      );
      expect(deps.length).toBe(0);
    }
  });

  it('addSpmDependency is idempotent (second call is a no-op)', async () => {
    if (!fixture) throw new Error('fixture not set up');
    const projPath = path.join(fixture, 'MinimalApp.xcodeproj');
    const proj = new XcodeProject(projPath);
    const args = {
      targetName: TARGET_NAME,
      packageUrl: 'https://github.com/bugsee/spm',
      productName: 'Bugsee',
      packageName: 'spm',
      requirement: { kind: 'upToNextMajorVersion' as const, version: '6.0.0' },
    };
    proj.addSpmDependency(args);
    proj.addSpmDependency(args);
    await proj.save();

    const reparsed = xcode.project(path.join(projPath, 'project.pbxproj'));
    reparsed.parseSync();
    const objects = reparsed.hash.project.objects as unknown as Record<
      string,
      Record<string, Record<string, unknown> | string>
    >;
    const refs = Object.entries(objects.XCRemoteSwiftPackageReference ?? {}).filter(
      ([k, v]) => !k.endsWith('_comment') && typeof v !== 'string',
    );
    expect(refs.length).toBe(1);
  });
});

describe('addSpmDependencyStep', () => {
  beforeEach(async () => {
    fixture = await makeFixture({});
    await copyFixtureInto(fixture);
  });

  it('precheck → apply → satisfied (round-trip)', async () => {
    if (!fixture) throw new Error('fixture not set up');
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: TARGET_NAME,
      iosOptions: { distribution: 'spm' },
    });
    expect(await addSpmDependencyStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await addSpmDependencyStep.apply(ctx);
    expect(await addSpmDependencyStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('rollback removes the dependency cleanly', async () => {
    if (!fixture) throw new Error('fixture not set up');
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: TARGET_NAME,
      iosOptions: { distribution: 'spm' },
    });
    await addSpmDependencyStep.apply(ctx);
    await addSpmDependencyStep.rollback(ctx);
    expect(await addSpmDependencyStep.precheck(ctx)).toEqual({ kind: 'pending' });
  });

  it('is satisfied when distribution is CocoaPods (no SPM work)', async () => {
    if (!fixture) throw new Error('fixture not set up');
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: TARGET_NAME,
      iosOptions: { distribution: 'cocoapods' },
    });
    expect(await addSpmDependencyStep.precheck(ctx)).toEqual({
      kind: 'satisfied',
      note: 'SPM not selected',
    });
  });

  it('blocks when target name does not exist', async () => {
    if (!fixture) throw new Error('fixture not set up');
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'NoSuchTarget',
      iosOptions: { distribution: 'spm' },
    });
    const status = await addSpmDependencyStep.precheck(ctx);
    expect(status.kind).toBe('blocked');
  });

  it('does not corrupt the rest of the file (PBXProject, target, build phases preserved)', async () => {
    if (!fixture) throw new Error('fixture not set up');
    const original = await readFile(
      path.join(fixture, 'MinimalApp.xcodeproj/project.pbxproj'),
      'utf8',
    );
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: TARGET_NAME,
      iosOptions: { distribution: 'spm' },
    });
    await addSpmDependencyStep.apply(ctx);
    const updated = await readFile(
      path.join(fixture, 'MinimalApp.xcodeproj/project.pbxproj'),
      'utf8',
    );
    // Sanity — the file changed, but core sections are still present.
    expect(updated).not.toBe(original);
    expect(updated).toContain('PBXNativeTarget');
    expect(updated).toContain('MinimalApp');
    expect(updated).toContain('PBXFrameworksBuildPhase');
    expect(updated).toContain('XCConfigurationList');
    expect(updated).toContain('rootObject = 111111111111111111111111');
  });
});

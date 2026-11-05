import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { androidDetector } from '../../src/detectors/android.js';
import { iosDetector } from '../../src/detectors/ios.js';
import { reactNativeDetector } from '../../src/detectors/react-native.js';

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

let fixture: string | undefined;

async function makeFixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bugsee-rn-detect-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

afterEach(async () => {
  if (fixture) {
    await rm(fixture, { recursive: true, force: true });
    fixture = undefined;
  }
});

const RN_PACKAGE_JSON = JSON.stringify(
  {
    name: 'AwesomeProject',
    version: '0.0.1',
    dependencies: { 'react-native': '0.74.0', react: '18.2.0' },
  },
  null,
  2,
);

describe('reactNativeDetector', () => {
  it('matches a typical RN project root', async () => {
    fixture = await makeFixture({
      'package.json': RN_PACKAGE_JSON,
      'android/app/build.gradle': '// stub',
      'ios/AwesomeProject.xcodeproj/project.pbxproj': '// stub',
    });
    const result = await reactNativeDetector.detect({ cwd: fixture });
    expect(result?.kind).toBe('react-native');
    expect(result?.confidence).toBe('high');
  });

  it('matches when only one platform subdir is present (android-only)', async () => {
    fixture = await makeFixture({
      'package.json': RN_PACKAGE_JSON,
      'android/app/build.gradle': '// stub',
    });
    const result = await reactNativeDetector.detect({ cwd: fixture });
    expect(result?.kind).toBe('react-native');
  });

  it('matches when react-native is in devDependencies', async () => {
    fixture = await makeFixture({
      'package.json': JSON.stringify({
        name: 'X',
        devDependencies: { 'react-native': '0.74.0' },
      }),
      'ios/X.xcodeproj/project.pbxproj': '// stub',
    });
    const result = await reactNativeDetector.detect({ cwd: fixture });
    expect(result?.kind).toBe('react-native');
  });

  it('does not count an ios/ dir without an .xcodeproj as an iOS platform', async () => {
    fixture = await makeFixture({
      'package.json': RN_PACKAGE_JSON,
      'android/app/build.gradle': '// stub',
      'ios/Podfile': '# stub',
    });
    const result = await reactNativeDetector.detect({ cwd: fixture });
    expect(result?.evidence.map((e) => e.path)).toEqual(['package.json', 'android/']);
  });

  it('does not match when the only platform dir is an ios/ without an .xcodeproj', async () => {
    fixture = await makeFixture({ 'package.json': RN_PACKAGE_JSON, 'ios/Podfile': '# stub' });
    expect(await reactNativeDetector.detect({ cwd: fixture })).toBeNull();
  });

  it('does not match a Node project without react-native', async () => {
    fixture = await makeFixture({
      'package.json': JSON.stringify({ name: 'X', dependencies: { express: '4.0.0' } }),
      'android/app/build.gradle': '// stub',
    });
    const result = await reactNativeDetector.detect({ cwd: fixture });
    expect(result).toBeNull();
  });

  it('does not match a package.json with react-native but no platform subdirs', async () => {
    fixture = await makeFixture({ 'package.json': RN_PACKAGE_JSON });
    const result = await reactNativeDetector.detect({ cwd: fixture });
    expect(result).toBeNull();
  });

  it('does not match when package.json is missing', async () => {
    fixture = await makeFixture({
      'android/app/build.gradle': '// stub',
      'ios/X.xcodeproj/project.pbxproj': '// stub',
    });
    const result = await reactNativeDetector.detect({ cwd: fixture });
    expect(result).toBeNull();
  });
});

describe('detector mutual exclusivity at RN root', () => {
  it('iOS detector does NOT match at RN root (only at the ios/ subdir)', async () => {
    fixture = await makeFixture({
      'package.json': RN_PACKAGE_JSON,
      'ios/AwesomeProject.xcodeproj/project.pbxproj': '// stub',
    });
    expect(await iosDetector.detect({ cwd: fixture })).toBeNull();
  });

  it('Android detector does NOT match at RN root (only at the android/ subdir)', async () => {
    fixture = await makeFixture({
      'package.json': RN_PACKAGE_JSON,
      'android/app/build.gradle': 'apply plugin: "com.android.application"\n',
    });
    expect(await androidDetector.detect({ cwd: fixture })).toBeNull();
  });

  it('Android detector still matches the RN android/ subdir directly', async () => {
    fixture = await makeFixture({
      'package.json': RN_PACKAGE_JSON,
      'android/app/build.gradle': 'apply plugin: "com.android.application"\n',
    });
    const result = await androidDetector.detect({ cwd: `${fixture}/android` });
    expect(result?.kind).toBe('android');
  });

  it('iOS detector still matches the RN ios/ subdir directly', async () => {
    fixture = await makeFixture({
      'package.json': RN_PACKAGE_JSON,
      'ios/AwesomeProject.xcodeproj/project.pbxproj': '// stub',
    });
    const result = await iosDetector.detect({ cwd: `${fixture}/ios` });
    expect(result?.kind).toBe('ios');
  });
});

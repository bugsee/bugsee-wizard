import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverIosPaths } from '../../src/recipes/ios/paths.js';
import {
  cleanup,
  makeFixture,
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
}));

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) {
    await cleanup(fixture);
    fixture = undefined;
  }
});

describe('discoverIosPaths', () => {
  it('finds xcodeproj, scheme, podfile, and AppDelegate at project root', async () => {
    fixture = await makeFixture({
      'MyApp.xcodeproj/project.pbxproj': '// stub',
      'MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme': SAMPLE_XCSCHEME,
      'MyApp/AppDelegate.swift': SAMPLE_APP_DELEGATE_SWIFT,
      Podfile: 'platform :ios, "13.0"\n',
    });
    const paths = await discoverIosPaths(fixture);
    expect(paths.xcodeProjectName).toBe('MyApp');
    expect(paths.schemeName).toBe('MyApp');
    expect(paths.podfile).not.toBeNull();
    expect(paths.appDelegate).not.toBeNull();
    expect(paths.appDelegateLanguage).toBe('swift');
  });

  it('discoverIosPaths is strict about cwd — RN-style ios/ subdir is rejected', async () => {
    fixture = await makeFixture({
      'ios/AwesomeProject.xcodeproj/project.pbxproj': '// stub',
      'ios/AwesomeProject.xcodeproj/xcshareddata/xcschemes/AwesomeProject.xcscheme':
        SAMPLE_XCSCHEME,
      'ios/Podfile': SAMPLE_RN_PODFILE,
    });
    // RN-style layout: callers must pass `<root>/ios` as cwd, not the
    // RN root. discoverIosPaths only inspects cwd-level files, so
    // pointing it at the RN root throws.
    await expect(discoverIosPaths(fixture)).rejects.toThrow(/\.xcodeproj/);
  });

  it('throws with a clear message when no shared scheme is present', async () => {
    fixture = await makeFixture({ 'MyApp.xcodeproj/project.pbxproj': '// stub' });
    await expect(discoverIosPaths(fixture)).rejects.toThrow(/shared scheme/i);
  });

  it('exposes all shared schemes for the multi-scheme picker (C11)', async () => {
    fixture = await makeFixture({
      'MyApp.xcodeproj/project.pbxproj': '// stub',
      'MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme': SAMPLE_XCSCHEME,
      'MyApp.xcodeproj/xcshareddata/xcschemes/Watch.xcscheme': SAMPLE_XCSCHEME,
      'MyApp.xcodeproj/xcshareddata/xcschemes/Extension.xcscheme': SAMPLE_XCSCHEME,
    });
    const paths = await discoverIosPaths(fixture);
    expect(paths.availableSchemes.length).toBe(3);
    // Default picks the one matching the project name.
    expect(paths.schemeName).toBe('MyApp');
  });

  it('returns null AppDelegate fields when not found', async () => {
    fixture = await makeFixture({
      'MyApp.xcodeproj/project.pbxproj': '// stub',
      'MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme': SAMPLE_XCSCHEME,
    });
    const paths = await discoverIosPaths(fixture);
    expect(paths.appDelegate).toBeNull();
    expect(paths.appDelegateLanguage).toBeNull();
  });
});

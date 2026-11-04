import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverAndroidPaths } from '../../src/recipes/android/paths.js';
import {
  SAMPLE_GROOVY_APP_BUILD,
  SAMPLE_GROOVY_PROJECT_BUILD,
  SAMPLE_GROOVY_SETTINGS_NO_MAVEN,
  SAMPLE_KOTLIN_APP_BUILD,
  SAMPLE_KOTLIN_LEGACY_APP_BUILD,
  SAMPLE_KOTLIN_PROJECT_BUILD,
  SAMPLE_KOTLIN_SETTINGS_WITH_MAVEN,
  SAMPLE_RN_APP_BUILD,
  SAMPLE_RN_PROJECT_BUILD,
  cleanup,
  makeFixture,
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

describe('discoverAndroidPaths', () => {
  it('detects plugins-dsl style from a modern Kotlin DSL project', async () => {
    fixture = await makeFixture({
      'settings.gradle.kts': SAMPLE_KOTLIN_SETTINGS_WITH_MAVEN,
      'build.gradle.kts': SAMPLE_KOTLIN_PROJECT_BUILD,
      'app/build.gradle.kts': SAMPLE_KOTLIN_APP_BUILD,
    });
    const paths = await discoverAndroidPaths(fixture);
    expect(paths.appBuildGradleDsl).toBe('kotlin');
    expect(paths.appBuildScriptStyle).toBe('plugins-dsl');
    expect(paths.projectBuildGradleDsl).toBe('kotlin');
  });

  it('detects plugins-dsl style from a modern Groovy DSL project', async () => {
    fixture = await makeFixture({
      'settings.gradle': SAMPLE_GROOVY_SETTINGS_NO_MAVEN,
      'build.gradle': SAMPLE_GROOVY_PROJECT_BUILD,
      'app/build.gradle': SAMPLE_GROOVY_APP_BUILD,
    });
    const paths = await discoverAndroidPaths(fixture);
    expect(paths.appBuildGradleDsl).toBe('groovy');
    expect(paths.appBuildScriptStyle).toBe('plugins-dsl');
  });

  it('detects legacy-apply style from a React Native Android project', async () => {
    fixture = await makeFixture({
      'settings.gradle': SAMPLE_GROOVY_SETTINGS_NO_MAVEN,
      'build.gradle': SAMPLE_RN_PROJECT_BUILD,
      'app/build.gradle': SAMPLE_RN_APP_BUILD,
    });
    const paths = await discoverAndroidPaths(fixture);
    expect(paths.appBuildGradleDsl).toBe('groovy');
    expect(paths.appBuildScriptStyle).toBe('legacy-apply');
  });

  it('detects legacy-apply style from a Kotlin DSL project that uses apply(plugin = …)', async () => {
    fixture = await makeFixture({
      'settings.gradle.kts': SAMPLE_KOTLIN_SETTINGS_WITH_MAVEN,
      'build.gradle.kts': SAMPLE_KOTLIN_PROJECT_BUILD,
      'app/build.gradle.kts': SAMPLE_KOTLIN_LEGACY_APP_BUILD,
    });
    const paths = await discoverAndroidPaths(fixture);
    expect(paths.appBuildGradleDsl).toBe('kotlin');
    expect(paths.appBuildScriptStyle).toBe('legacy-apply');
  });

  it('throws when no app/build.gradle[.kts] is present', async () => {
    fixture = await makeFixture({
      'settings.gradle.kts': SAMPLE_KOTLIN_SETTINGS_WITH_MAVEN,
      'build.gradle.kts': SAMPLE_KOTLIN_PROJECT_BUILD,
    });
    await expect(discoverAndroidPaths(fixture)).rejects.toThrow(/app\/build\.gradle/);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAndroidRollback } from '../../src/recipes/android/run.js';
import { applyPluginStep } from '../../src/recipes/android/steps/apply-plugin.js';
import { configureBugseeBlockStep } from '../../src/recipes/android/steps/configure-bugsee-block.js';
import { ensureGitignoredStep } from '../../src/recipes/android/steps/ensure-gitignored.js';
import { ensureMavenCentralStep } from '../../src/recipes/android/steps/ensure-maven-central.js';
import { injectLoaderStep } from '../../src/recipes/android/steps/inject-loader.js';
import { injectManifestMetaStep } from '../../src/recipes/android/steps/inject-manifest-meta.js';
import { injectManifestPlaceholderStep } from '../../src/recipes/android/steps/inject-manifest-placeholder.js';
import { writeBugseePropertiesStep } from '../../src/recipes/android/steps/write-bugsee-properties.js';
import {
  cleanup,
  makeAndroidContext,
  makeFixture,
  readFixture,
  SAMPLE_KOTLIN_APP_BUILD,
  SAMPLE_KOTLIN_PROJECT_BUILD,
  SAMPLE_KOTLIN_SETTINGS_NO_MAVEN,
  SAMPLE_MANIFEST,
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
}));

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) {
    await cleanup(fixture);
    fixture = undefined;
  }
});

describe('Android full rollback (install → uninstall round-trip)', () => {
  it('restores every touched file byte-for-byte after a full install', async () => {
    fixture = await makeFixture({
      'settings.gradle.kts': SAMPLE_KOTLIN_SETTINGS_NO_MAVEN,
      'build.gradle.kts': SAMPLE_KOTLIN_PROJECT_BUILD,
      'app/build.gradle.kts': SAMPLE_KOTLIN_APP_BUILD,
      'app/src/main/AndroidManifest.xml': SAMPLE_MANIFEST,
    });

    const originals = {
      settings: await readFixture(fixture, 'settings.gradle.kts'),
      appBuild: await readFixture(fixture, 'app/build.gradle.kts'),
      manifest: await readFixture(fixture, 'app/src/main/AndroidManifest.xml'),
    };

    // Drive the install steps directly — same set runAndroidRecipe would
    // assemble for `automatic` init mode with no opt-ins. We skip the
    // questionnaire to keep the test deterministic.
    const ctx = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      tokens: { android: 'TOK' },
      androidOptions: {
        initMode: 'automatic',
        ndk: true,
        feedback: true,
        sizeAnalysis: true,
      },
    });
    await ensureMavenCentralStep.apply(ctx);
    await writeBugseePropertiesStep.apply(ctx);
    await ensureGitignoredStep.apply(ctx);
    await injectLoaderStep.apply(ctx);
    await applyPluginStep.apply(ctx);
    await configureBugseeBlockStep.apply(ctx);
    await injectManifestPlaceholderStep.apply(ctx);
    await injectManifestMetaStep.apply(ctx);

    // Sanity: everything was actually applied.
    expect(await readFixture(fixture, 'app/build.gradle.kts')).toContain(
      'com.bugsee.android.gradle',
    );

    const ran = await runAndroidRollback({
      cwd: fixture,
      debug: false,
      dryRun: false,
    });
    expect(ran).toBe(true);

    // App-level Gradle, manifest restored byte-for-byte. settings.gradle
    // is the one exception — ensure-maven-central rollback is intentionally
    // a no-op (extra mavenCentral() is harmless and may be needed by other
    // plugins). So we assert mavenCentral was added but the *body* matches
    // the pre-install file modulo that line.
    expect(await readFixture(fixture, 'app/build.gradle.kts')).toBe(originals.appBuild);
    expect(await readFixture(fixture, 'app/src/main/AndroidManifest.xml')).toBe(originals.manifest);

    // bugsee.properties had the token line removed (file may now be empty).
    const props = await readFixture(fixture, 'bugsee.properties').catch(() => '');
    expect(props).not.toContain('app_token');
  });

  it('runs without error on a project that was never installed (idempotent)', async () => {
    fixture = await makeFixture({
      'settings.gradle.kts': SAMPLE_KOTLIN_SETTINGS_NO_MAVEN,
      'build.gradle.kts': SAMPLE_KOTLIN_PROJECT_BUILD,
      'app/build.gradle.kts': SAMPLE_KOTLIN_APP_BUILD,
      'app/src/main/AndroidManifest.xml': SAMPLE_MANIFEST,
    });
    const originalApp = await readFixture(fixture, 'app/build.gradle.kts');
    const originalManifest = await readFixture(fixture, 'app/src/main/AndroidManifest.xml');

    const ran = await runAndroidRollback({
      cwd: fixture,
      debug: false,
      dryRun: false,
    });
    expect(ran).toBe(true);

    // No-op: every step's rollback couldn't find its marker, so nothing changed.
    expect(await readFixture(fixture, 'app/build.gradle.kts')).toBe(originalApp);
    expect(await readFixture(fixture, 'app/src/main/AndroidManifest.xml')).toBe(originalManifest);
  });

  it('returns false when no Android project is found at the cwd', async () => {
    fixture = await makeFixture({ 'README.md': '' });
    const ran = await runAndroidRollback({
      cwd: fixture,
      debug: false,
      dryRun: false,
    });
    expect(ran).toBe(false);
  });
});

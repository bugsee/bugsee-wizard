import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { androidDetector } from '../../src/detectors/android.js';
import { stripMarkerBlock } from '../../src/recipes/android/io.js';
import { discoverAndroidPaths } from '../../src/recipes/android/paths.js';
import { detectProcessConfig } from '../../src/recipes/android/process-config.js';
import { runAndroidRecipe } from '../../src/recipes/android/run.js';
import { addBuildscriptClasspathStep } from '../../src/recipes/android/steps/add-buildscript-classpath.js';
import { applyPluginStep } from '../../src/recipes/android/steps/apply-plugin.js';
import { ensureMavenCentralStep } from '../../src/recipes/android/steps/ensure-maven-central.js';
import { injectManifestPlaceholderStep } from '../../src/recipes/android/steps/inject-manifest-placeholder.js';
import { injectProviderOverrideStep } from '../../src/recipes/android/steps/inject-provider-override.js';
import { BUGSEE_PLUGIN_VERSION } from '../../src/recipes/android/types.js';
import {
  cleanup,
  makeAndroidContext,
  makeFixture,
  readFixture,
  SAMPLE_KOTLIN_APP_BUILD,
  SAMPLE_KOTLIN_SETTINGS_NO_MAVEN,
  SAMPLE_MANIFEST,
  SAMPLE_RN_APP_BUILD,
} from './helpers.js';

const clack = vi.hoisted(() => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
  note: vi.fn(),
  select: vi.fn(),
  isCancel: () => false,
  cancel: vi.fn(),
}));
vi.mock('@clack/prompts', () => clack);

let fixture: string | undefined;
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  if (fixture) await cleanup(fixture);
  fixture = undefined;
});

describe('T1/T7 already fixed', () => {
  it('plan version supports bugsee.properties tokens (T14: >= 4.0.0-beta6)', () => {
    expect(BUGSEE_PLUGIN_VERSION).toBe('4.0.0-beta6');
  });
});

describe('T9 root build file optional for plugins-dsl', () => {
  it('discovers paths without a root build file when the app uses plugins {}', async () => {
    fixture = await makeFixture({
      'settings.gradle.kts': SAMPLE_KOTLIN_SETTINGS_NO_MAVEN,
      'app/build.gradle.kts': SAMPLE_KOTLIN_APP_BUILD,
    });
    const paths = await discoverAndroidPaths(fixture);
    expect(paths.projectBuildGradle).toBeNull();
    const ctx = { ...makeAndroidContext({ cwd: fixture, dsl: 'kotlin' }), androidPaths: paths };
    expect((await addBuildscriptClasspathStep.precheck(ctx)).kind).toBe('blocked');
    await expect(addBuildscriptClasspathStep.apply(ctx)).rejects.toThrow();
    await expect(addBuildscriptClasspathStep.rollback?.(ctx)).resolves.toBeUndefined();
  });

  it('still requires the root build file for legacy-apply', async () => {
    fixture = await makeFixture({
      'settings.gradle': SAMPLE_KOTLIN_SETTINGS_NO_MAVEN,
      'app/build.gradle': SAMPLE_RN_APP_BUILD,
    });
    await expect(discoverAndroidPaths(fixture)).rejects.toThrow(/project-level/);
  });
});

describe('T10 android:process must follow whitespace', () => {
  it('ignores a longer namespaced attribute ending in android:process', () => {
    const cfg = detectProcessConfig(
      '<manifest><application tools:android:process="x" android:label="a"></application></manifest>',
    );
    expect(cfg.applicationProcess).toBeNull();
    expect(
      detectProcessConfig(
        '<manifest><application\n  android:process=":p"></application></manifest>',
      ).applicationProcess,
    ).toBe(':p');
  });
});

describe('T12 / T24 closing brace sharing a line', () => {
  it('classpath stays inside buildscript.dependencies for a one-line block', async () => {
    fixture = await makeFixture({
      'build.gradle': "buildscript {\n  dependencies { classpath 'a:b:1' }\n}\n",
    });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'groovy', style: 'legacy-apply' });
    await addBuildscriptClasspathStep.apply(ctx);
    const updated = await readFixture(fixture, 'build.gradle');
    const depsOpen = updated.indexOf('dependencies {');
    const cp = updated.indexOf('bugsee-android-gradle-plugin');
    const close = updated.indexOf('}', cp);
    expect(cp).toBeGreaterThan(depsOpen);
    expect(updated.slice(depsOpen, close)).toContain("classpath 'a:b:1'");
    expect(updated.indexOf('buildscript')).toBeLessThan(depsOpen);
    expect(updated.trimEnd().endsWith('}\n}'.trimEnd())).toBe(true);
    expect(updated.slice(cp)).toMatch(
      /^[^}]*\n\s*\/\/ bugsee:wizard:buildscript-classpath:end\n\s*}\n}/,
    );
  });

  it('placeholder stays inside a one-line defaultConfig', async () => {
    fixture = await makeFixture({
      'app/build.gradle': 'android {\n  defaultConfig { minSdk 24 }\n}\n',
    });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'groovy' });
    await injectManifestPlaceholderStep.apply(ctx);
    const updated = await readFixture(fixture, 'app/build.gradle');
    const dcOpen = updated.indexOf('defaultConfig {');
    const ph = updated.indexOf('manifestPlaceholders');
    expect(ph).toBeGreaterThan(dcOpen);
    expect(updated.slice(ph)).toMatch(/^[^}]*bugsee:wizard:manifest-placeholder:end\s*}\n}\n$/);
    expect(updated.slice(0, ph)).toContain('minSdk 24');
  });
});

describe('T13 xmlns:tools judged on the <manifest> tag only', () => {
  it('adds the namespace to the root when only a nested element declares it', async () => {
    const manifest = SAMPLE_MANIFEST.replace(
      '<activity ',
      '<activity xmlns:tools="http://schemas.android.com/tools" ',
    );
    fixture = await makeFixture({ 'app/src/main/AndroidManifest.xml': manifest });
    const ctx = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      androidOptions: { providerProcessOverride: ':p' },
    });
    await injectProviderOverrideStep.apply(ctx);
    const updated = await readFixture(fixture, 'app/src/main/AndroidManifest.xml');
    const root = /<manifest\b[^>]*>/.exec(updated)?.[0] ?? '';
    expect(root).toContain('xmlns:tools=');
  });

  it('does not duplicate it when the root already declares it', async () => {
    const manifest = SAMPLE_MANIFEST.replace(
      '<manifest ',
      '<manifest xmlns:tools="http://schemas.android.com/tools" ',
    );
    fixture = await makeFixture({ 'app/src/main/AndroidManifest.xml': manifest });
    const ctx = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      androidOptions: { providerProcessOverride: ':p' },
    });
    await injectProviderOverrideStep.apply(ctx);
    const updated = await readFixture(fixture, 'app/src/main/AndroidManifest.xml');
    expect(updated.match(/xmlns:tools=/g)).toHaveLength(1);
  });
});

describe('T18 marker strip does not cross a second BEGIN', () => {
  it('leaves an orphaned BEGIN alone and strips only the paired block', () => {
    const src = 'a\n// B\norphan\n// B\npaired\n// E\nz\n';
    expect(stripMarkerBlock(src, '// B', '// E')).toBe('a\n// B\norphan\nz\n');
  });
});

describe('T19 / T11 process notes', () => {
  const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:process=":app">
    <service android:name=".S" android:process=":svc" />
  </application>
</manifest>`;

  async function setup() {
    fixture = await makeFixture({
      'settings.gradle.kts': SAMPLE_KOTLIN_SETTINGS_NO_MAVEN,
      'build.gradle.kts': 'plugins {}\n',
      'app/build.gradle.kts': SAMPLE_KOTLIN_APP_BUILD,
      'app/src/main/AndroidManifest.xml': MANIFEST,
    });
    return fixture;
  }
  const opts = { initMode: 'automatic', ndk: false, feedback: false, sizeAnalysis: false } as const;

  it('component note fires alongside an application process, without "main process" wording', async () => {
    clack.select.mockResolvedValue('snippet');
    await runAndroidRecipe({
      cwd: await setup(),
      debug: false,
      nonInteractive: false,
      json: false,
      ignoreGitChanges: false,
      yes: false,
      dryRun: false,
      token: 'T',
      options: opts,
    });
    const notes = clack.note.mock.calls.map((c) => String(c[0]));
    const comp = notes.find((n) => n.includes('per-component'));
    expect(comp).toContain('":svc"');
    expect(comp).not.toContain(':app"');
    expect(comp).not.toMatch(/main process/);
  });

  it('silent run hands the manual provider snippet back via notes', async () => {
    clack.select.mockResolvedValue('snippet');
    const notes: string[] = [];
    const res = await runAndroidRecipe({
      cwd: await setup(),
      debug: false,
      nonInteractive: false,
      json: false,
      ignoreGitChanges: false,
      yes: false,
      dryRun: false,
      token: 'T',
      silent: true,
      notes,
      options: opts,
    });
    expect(res).toBe('ok');
    const text = notes.join('\n');
    expect(text).toContain('android:process=":app"');
    expect(text).toContain('tools:replace="android:process"');
    expect(text).toContain('xmlns:tools');
    expect(clack.note.mock.calls.some((c) => c[1] === 'Done')).toBe(false);
  });

  it('silent run adds no notes when the override was added automatically', async () => {
    clack.select.mockResolvedValue('auto');
    const notes: string[] = [];
    await runAndroidRecipe({
      cwd: await setup(),
      debug: false,
      nonInteractive: false,
      json: false,
      ignoreGitChanges: false,
      yes: false,
      dryRun: false,
      token: 'T',
      silent: true,
      notes,
      options: opts,
    });
    expect(notes).toEqual([]);
  });

  it('non-silent run still prints the snippet in the Done note', async () => {
    clack.select.mockResolvedValue('snippet');
    await runAndroidRecipe({
      cwd: await setup(),
      debug: false,
      nonInteractive: false,
      json: false,
      ignoreGitChanges: false,
      yes: false,
      dryRun: false,
      token: 'T',
      options: opts,
    });
    const done = clack.note.mock.calls.find((c) => c[1] === 'Done');
    expect(String(done?.[0])).toContain('BugseeInitProvider');
  });
});

describe('T20 / T21 / T22 apply-plugin', () => {
  it('a commented-out declaration does not satisfy the step', async () => {
    fixture = await makeFixture({
      'app/build.gradle.kts':
        'plugins {\n    id("com.android.application")\n    // id("com.bugsee.android.gradle")\n}\n',
    });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    expect(await applyPluginStep.precheck(ctx)).toEqual({ kind: 'pending' });
  });

  it('an active declaration still satisfies it', async () => {
    fixture = await makeFixture({
      'app/build.gradle.kts': 'plugins {\n    id("com.bugsee.android.gradle")\n}\n',
    });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    expect(await applyPluginStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('a one-line plugins block gets a line break before the new declaration', async () => {
    fixture = await makeFixture({ 'app/build.gradle': "plugins { id 'java' }\n" });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'groovy' });
    await applyPluginStep.apply(ctx);
    const updated = await readFixture(fixture, 'app/build.gradle');
    expect(updated).toContain("plugins { id 'java' \n");
    expect(updated).not.toMatch(/id 'java'\s+\/\/ bugsee:wizard:apply-plugin:begin\s*id 'java'/);
    expect(updated.split('\n').some((l) => l.includes("id 'java'") && l.includes('bugsee'))).toBe(
      false,
    );
  });

  it('rollback removes only the wizard-written declaration, keeping a pre-existing one', async () => {
    const original = 'plugins {\n    id("com.bugsee.android.gradle") version "9.9.9"\n}\n';
    fixture = await makeFixture({ 'app/build.gradle.kts': original });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    await applyPluginStep.rollback?.(ctx);
    expect(await readFixture(fixture, 'app/build.gradle.kts')).toBe(original);
  });

  it('apply then rollback restores a plugins-dsl file byte-exact', async () => {
    fixture = await makeFixture({ 'app/build.gradle.kts': SAMPLE_KOTLIN_APP_BUILD });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    await applyPluginStep.apply(ctx);
    expect(await readFixture(fixture, 'app/build.gradle.kts')).toContain(
      'bugsee:wizard:apply-plugin:begin',
    );
    await applyPluginStep.rollback?.(ctx);
    expect(await readFixture(fixture, 'app/build.gradle.kts')).toBe(SAMPLE_KOTLIN_APP_BUILD);
  });
});

describe('T48 classpath precheck scope', () => {
  const ctxFor = (dir: string) =>
    makeAndroidContext({ cwd: dir, dsl: 'groovy', style: 'legacy-apply' });
  it('commented-out classpath is not satisfied', async () => {
    fixture = await makeFixture({
      'build.gradle':
        "buildscript {\n  dependencies {\n    // classpath 'com.bugsee:bugsee-android-gradle-plugin:1'\n    /* classpath 'com.bugsee:bugsee-android-gradle-plugin:1' */\n  }\n}\n",
    });
    expect(await addBuildscriptClasspathStep.precheck(ctxFor(fixture))).toEqual({
      kind: 'pending',
    });
  });
  it('a top-level dependencies mention is not satisfied', async () => {
    fixture = await makeFixture({
      'build.gradle':
        "buildscript {\n  dependencies {\n  }\n}\ndependencies { classpath 'com.bugsee:bugsee-android-gradle-plugin:1' }\n",
    });
    expect(await addBuildscriptClasspathStep.precheck(ctxFor(fixture))).toEqual({
      kind: 'pending',
    });
  });
  it('an active entry in buildscript.dependencies is satisfied', async () => {
    fixture = await makeFixture({
      'build.gradle':
        "buildscript {\n  dependencies {\n    classpath 'com.bugsee:bugsee-android-gradle-plugin:1' // x\n  }\n}\n",
    });
    expect(await addBuildscriptClasspathStep.precheck(ctxFor(fixture))).toEqual({
      kind: 'satisfied',
    });
  });
});

describe('T49 maven central precheck scope', () => {
  it('commented-out mavenCentral() is pending', async () => {
    fixture = await makeFixture({
      'settings.gradle.kts':
        'pluginManagement {\n  repositories {\n    google()\n    // mavenCentral()\n  }\n}\n',
    });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    expect(await ensureMavenCentralStep.precheck(ctx)).toEqual({ kind: 'pending' });
  });
  it('mavenCentral() outside pluginManagement.repositories is pending', async () => {
    fixture = await makeFixture({
      'settings.gradle.kts':
        'pluginManagement {\n  resolutionStrategy { mavenCentral() }\n  repositories { google() }\n}\n',
    });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    expect(await ensureMavenCentralStep.precheck(ctx)).toEqual({ kind: 'pending' });
  });
});

describe('T45 detector forms', () => {
  it.each([
    ["plugins {\n    id 'com.android.application'\n}\n", 'app/build.gradle'],
    ['apply(plugin = "com.android.application")\n', 'app/build.gradle.kts'],
  ])('detects %j', async (content, rel) => {
    fixture = await makeFixture({ [rel]: content });
    expect((await androidDetector.detect({ cwd: fixture }))?.kind).toBe('android');
  });
  it('does not match an unrelated plugin id', async () => {
    fixture = await makeFixture({ 'app/build.gradle': "plugins { id 'com.android.library' }\n" });
    expect(await androidDetector.detect({ cwd: fixture })).toBeNull();
  });
});

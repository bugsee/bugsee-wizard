import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addBuildscriptClasspathStep } from '../../src/recipes/android/steps/add-buildscript-classpath.js';
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
  SAMPLE_GROOVY_APP_BUILD,
  SAMPLE_GROOVY_SETTINGS_NO_MAVEN,
  SAMPLE_KOTLIN_APP_BUILD,
  SAMPLE_KOTLIN_LEGACY_APP_BUILD,
  SAMPLE_KOTLIN_SETTINGS_NO_MAVEN,
  SAMPLE_KOTLIN_SETTINGS_WITH_MAVEN,
  SAMPLE_MANIFEST,
  SAMPLE_RN_APP_BUILD,
  SAMPLE_RN_PROJECT_BUILD,
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

let fixture: string;
afterEach(async () => {
  if (fixture) await cleanup(fixture);
});

describe('ensureMavenCentralStep', () => {
  beforeEach(async () => {
    fixture = await makeFixture({
      'settings.gradle.kts': SAMPLE_KOTLIN_SETTINGS_NO_MAVEN,
      'app/build.gradle.kts': SAMPLE_KOTLIN_APP_BUILD,
      'app/src/main/AndroidManifest.xml': SAMPLE_MANIFEST,
    });
  });

  it('returns satisfied when mavenCentral() is already in pluginManagement', async () => {
    const dir = await makeFixture({ 'settings.gradle.kts': SAMPLE_KOTLIN_SETTINGS_WITH_MAVEN });
    const ctx = makeAndroidContext({ cwd: dir, dsl: 'kotlin' });
    expect(await ensureMavenCentralStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await cleanup(dir);
  });

  it('adds mavenCentral() inside an existing repositories block', async () => {
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    expect(await ensureMavenCentralStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await ensureMavenCentralStep.apply(ctx);
    const updated = await readFixture(fixture, 'settings.gradle.kts');
    expect(updated).toContain('mavenCentral()');
    expect(await ensureMavenCentralStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('blocks when settings.gradle is missing', async () => {
    const empty = await makeFixture({ 'README.md': '' });
    const ctx = makeAndroidContext({ cwd: empty, dsl: 'kotlin' });
    const status = await ensureMavenCentralStep.precheck(ctx);
    expect(status.kind).toBe('blocked');
    await cleanup(empty);
  });

  it('handles Groovy DSL settings.gradle (no pluginManagement) by prepending block', async () => {
    const dir = await makeFixture({
      'settings.gradle': `rootProject.name = "MyApp"\ninclude ':app'\n`,
    });
    const ctx = makeAndroidContext({ cwd: dir, dsl: 'groovy' });
    expect(await ensureMavenCentralStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await ensureMavenCentralStep.apply(ctx);
    const updated = await readFixture(dir, 'settings.gradle');
    expect(updated.startsWith('pluginManagement')).toBe(true);
    expect(updated).toContain('mavenCentral()');
    expect(updated).toContain(`include ':app'`);
    await cleanup(dir);
  });

  it('handles Groovy DSL with existing pluginManagement but no mavenCentral', async () => {
    const dir = await makeFixture({ 'settings.gradle': SAMPLE_GROOVY_SETTINGS_NO_MAVEN });
    const ctx = makeAndroidContext({ cwd: dir, dsl: 'groovy' });
    await ensureMavenCentralStep.apply(ctx);
    const updated = await readFixture(dir, 'settings.gradle');
    expect(updated).toContain('mavenCentral()');
    expect(await ensureMavenCentralStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await cleanup(dir);
  });
});

describe('writeBugseePropertiesStep', () => {
  beforeEach(async () => {
    fixture = await makeFixture({});
  });

  it('writes the token to bugsee.properties when missing', async () => {
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin', tokens: { android: 'tok-1' } });
    expect(await writeBugseePropertiesStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await writeBugseePropertiesStep.apply(ctx);
    expect(await readFixture(fixture, 'bugsee.properties')).toContain('app_token=tok-1');
    expect(await writeBugseePropertiesStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('rolls back by removing the token line', async () => {
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin', tokens: { android: 'tok-1' } });
    await writeBugseePropertiesStep.apply(ctx);
    await writeBugseePropertiesStep.rollback(ctx);
    const remaining = await readFixture(fixture, 'bugsee.properties');
    expect(remaining).not.toContain('app_token');
  });

  it('preserves other bugsee.properties entries (extension keys)', async () => {
    fixture = await makeFixture({ 'bugsee.properties': 'endpoint=https://example.com\n' });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin', tokens: { android: 'tok-1' } });
    await writeBugseePropertiesStep.apply(ctx);
    const updated = await readFixture(fixture, 'bugsee.properties');
    expect(updated).toContain('endpoint=https://example.com');
    expect(updated).toContain('app_token=tok-1');
  });
});

describe('writeBugseePropertiesStep — differing stored token', () => {
  it('is satisfied when the stored token equals the supplied one (even with spaces/CRLF)', async () => {
    fixture = await makeFixture({ 'bugsee.properties': 'app_token = tok-1 \r\n' });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin', tokens: { android: 'tok-1' } });
    expect(await writeBugseePropertiesStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('is pending when the stored token differs, and apply replaces it in place', async () => {
    fixture = await makeFixture({
      'bugsee.properties': 'a=1\napp_token=old-token\nb=2\n',
    });
    const ctx = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      tokens: { android: 'new-token' },
    });
    expect(await writeBugseePropertiesStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await writeBugseePropertiesStep.apply(ctx);
    expect(await readFixture(fixture, 'bugsee.properties')).toBe('a=1\napp_token=new-token\nb=2\n');
    expect(await writeBugseePropertiesStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('replaces duplicate token lines with a single one', async () => {
    fixture = await makeFixture({ 'bugsee.properties': 'app_token=a\napp_token=b\n' });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin', tokens: { android: 'c' } });
    await writeBugseePropertiesStep.apply(ctx);
    expect(await readFixture(fixture, 'bugsee.properties')).toBe('app_token=c\n');
  });

  it('rollback after a replace removes the token line', async () => {
    fixture = await makeFixture({ 'bugsee.properties': 'a=1\napp_token=old\n' });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin', tokens: { android: 'new' } });
    await writeBugseePropertiesStep.apply(ctx);
    await writeBugseePropertiesStep.rollback(ctx);
    expect(await readFixture(fixture, 'bugsee.properties')).not.toContain('app_token');
    expect(await readFixture(fixture, 'bugsee.properties')).toContain('a=1');
  });

  it('is satisfied (nothing to compare) when no token was supplied but one is stored', async () => {
    fixture = await makeFixture({ 'bugsee.properties': 'app_token=old\n' });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin', tokens: {} });
    expect(await writeBugseePropertiesStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });
});

describe('writeBugseePropertiesStep — CRLF', () => {
  it('preserves the CRLF ending of the replaced line and uses CRLF when appending', async () => {
    fixture = await makeFixture({ 'bugsee.properties': 'a=1\r\napp_token=old\r\nb=2\r\n' });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin', tokens: { android: 'new' } });
    await writeBugseePropertiesStep.apply(ctx);
    expect(await readFixture(fixture, 'bugsee.properties')).toBe('a=1\r\napp_token=new\r\nb=2\r\n');
    await cleanup(fixture);
    fixture = await makeFixture({ 'bugsee.properties': 'a=1\r\nb=2' });
    await writeBugseePropertiesStep.apply(
      makeAndroidContext({ cwd: fixture, dsl: 'kotlin', tokens: { android: 'n' } }),
    );
    expect(await readFixture(fixture, 'bugsee.properties')).toBe('a=1\r\nb=2\r\napp_token=n\r\n');
  });
});

describe('ensureGitignoredStep', () => {
  beforeEach(async () => {
    fixture = await makeFixture({});
  });

  it('appends bugsee.properties to .gitignore when missing', async () => {
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    expect(await ensureGitignoredStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await ensureGitignoredStep.apply(ctx);
    const updated = await readFixture(fixture, '.gitignore');
    expect(updated).toContain('bugsee.properties');
    expect(await ensureGitignoredStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('is satisfied when bugsee.properties is already gitignored', async () => {
    fixture = await makeFixture({ '.gitignore': 'node_modules/\nbugsee.properties\n' });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    expect(await ensureGitignoredStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('rolls back by removing only our marked entry', async () => {
    fixture = await makeFixture({ '.gitignore': 'node_modules/\n*.log\n' });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    const original = await readFixture(fixture, '.gitignore');
    await ensureGitignoredStep.apply(ctx);
    await ensureGitignoredStep.rollback(ctx);
    const restored = await readFixture(fixture, '.gitignore');
    expect(restored).toBe(original);
  });

  it('rollback leaves user-added bugsee.properties entry alone (no marker)', async () => {
    fixture = await makeFixture({ '.gitignore': 'node_modules/\nbugsee.properties\n' });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    await ensureGitignoredStep.rollback(ctx);
    const content = await readFixture(fixture, '.gitignore');
    expect(content).toContain('bugsee.properties');
  });
});

describe('injectLoaderStep', () => {
  beforeEach(async () => {
    fixture = await makeFixture({
      'settings.gradle.kts': SAMPLE_KOTLIN_SETTINGS_WITH_MAVEN,
      'app/build.gradle.kts': SAMPLE_KOTLIN_APP_BUILD,
    });
  });

  it('injects the Kotlin DSL loader after the plugins block', async () => {
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    expect(await injectLoaderStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await injectLoaderStep.apply(ctx);
    const updated = await readFixture(fixture, 'app/build.gradle.kts');
    expect(updated).toContain('val bugseeAppToken: String =');
    expect(updated.indexOf('bugseeAppToken')).toBeGreaterThan(updated.indexOf('plugins {'));
    // Kotlin `import`s must precede every statement, so the loader uses
    // fully-qualified names and carries no import lines.
    expect(updated).not.toMatch(/^import /m);
    expect(updated).toContain('java.util.Properties()');
    expect(await injectLoaderStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('Groovy: places the loader immediately after the plugins block', async () => {
    const dir = await makeFixture({ 'app/build.gradle': SAMPLE_GROOVY_APP_BUILD });
    const ctx = makeAndroidContext({ cwd: dir, dsl: 'groovy' });
    const original = await readFixture(dir, 'app/build.gradle');
    await injectLoaderStep.apply(ctx);
    const updated = await readFixture(dir, 'app/build.gradle');
    const pluginsEnd = updated.indexOf('}\n', updated.indexOf('plugins {')) + 2;
    expect(updated.slice(0, pluginsEnd)).toBe(original.slice(0, pluginsEnd));
    expect(updated.indexOf('def bugseeAppToken')).toBeGreaterThan(updated.indexOf('plugins {'));
    expect(updated.slice(pluginsEnd).startsWith('// bugsee:wizard:loader:begin')).toBe(true);
    expect(updated.indexOf('android {')).toBeGreaterThan(updated.indexOf('def bugseeAppToken'));
    await injectLoaderStep.rollback(ctx);
    expect(await readFixture(dir, 'app/build.gradle')).toBe(original);
    await cleanup(dir);
  });

  it('without a plugins block, inserts at the file top (Groovy)', async () => {
    const dir = await makeFixture({ 'app/build.gradle': SAMPLE_RN_APP_BUILD });
    const ctx = makeAndroidContext({ cwd: dir, dsl: 'groovy', style: 'legacy-apply' });
    await injectLoaderStep.apply(ctx);
    const updated = await readFixture(dir, 'app/build.gradle');
    expect(updated.startsWith('// bugsee:wizard:loader:begin')).toBe(true);
    await cleanup(dir);
  });

  it('without a plugins block, keeps Kotlin imports above the loader', async () => {
    const src = 'import java.io.File\nimport java.util.Date\n\napply(plugin = "x")\n';
    const dir = await makeFixture({ 'app/build.gradle.kts': src });
    const ctx = makeAndroidContext({ cwd: dir, dsl: 'kotlin', style: 'legacy-apply' });
    await injectLoaderStep.apply(ctx);
    const updated = await readFixture(dir, 'app/build.gradle.kts');
    expect(updated.startsWith('import java.io.File\nimport java.util.Date\n')).toBe(true);
    expect(updated.indexOf('bugseeAppToken')).toBeGreaterThan(
      updated.indexOf('import java.util.Date'),
    );
    await injectLoaderStep.rollback(ctx);
    expect(await readFixture(dir, 'app/build.gradle.kts')).toBe(src);
    await cleanup(dir);
  });

  it('rolls back by stripping the loader marker block', async () => {
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    const original = await readFixture(fixture, 'app/build.gradle.kts');
    await injectLoaderStep.apply(ctx);
    await injectLoaderStep.rollback(ctx);
    const restored = await readFixture(fixture, 'app/build.gradle.kts');
    expect(restored).toBe(original);
  });

  it('handles Groovy DSL', async () => {
    const dir = await makeFixture({ 'app/build.gradle': SAMPLE_GROOVY_APP_BUILD });
    const ctx = makeAndroidContext({ cwd: dir, dsl: 'groovy' });
    await injectLoaderStep.apply(ctx);
    const updated = await readFixture(dir, 'app/build.gradle');
    expect(updated).toContain('def bugseeAppToken =');
    expect(await injectLoaderStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await cleanup(dir);
  });
});

describe('injectLoaderStep — placement edge cases (Groovy)', () => {
  const BEGIN = '// bugsee:wizard:loader:begin';
  const GROOVY_LOADER = (eol: string) =>
    [
      BEGIN,
      'def bugseeProps = new Properties()',
      "def bugseePropsFile = rootProject.file('bugsee.properties')",
      'if (bugseePropsFile.exists()) {',
      '    bugseePropsFile.withInputStream { bugseeProps.load(it) }',
      '}',
      "def bugseeAppToken = bugseeProps.getProperty('app_token', '')",
      '// bugsee:wizard:loader:end',
      '',
    ].join(eol);

  async function run(src: string): Promise<{ out: string; restored: string }> {
    const dir = await makeFixture({ 'app/build.gradle': src });
    try {
      const ctx = makeAndroidContext({ cwd: dir, dsl: 'groovy' });
      await injectLoaderStep.apply(ctx);
      const out = await readFixture(dir, 'app/build.gradle');
      await injectLoaderStep.rollback(ctx);
      return { out, restored: await readFixture(dir, 'app/build.gradle') };
    } finally {
      await cleanup(dir);
    }
  }

  it('ignores `plugins {` in a line comment before the real block', async () => {
    const src = "// plugins { not real }\nplugins {\n    id 'a'\n}\nandroid {}\n";
    const { out, restored } = await run(src);
    expect(out).toBe(
      `// plugins { not real }\nplugins {\n    id 'a'\n}\n${GROOVY_LOADER('\n')}android {}\n`,
    );
    expect(restored).toBe(src);
  });

  it('ignores `plugins {` in a block comment before the real block', async () => {
    const src = "/* plugins {\n  x\n} */\nplugins {\n    id 'a'\n}\nandroid {}\n";
    const { out } = await run(src);
    expect(out).toBe(
      `/* plugins {\n  x\n} */\nplugins {\n    id 'a'\n}\n${GROOVY_LOADER('\n')}android {}\n`,
    );
  });

  it('ignores `plugins {` inside a string', async () => {
    const src = 'def s = "plugins { x"\nplugins {\n    id \'a\'\n}\nandroid {}\n';
    const { out } = await run(src);
    expect(out).toBe(
      `def s = "plugins { x"\nplugins {\n    id 'a'\n}\n${GROOVY_LOADER('\n')}android {}\n`,
    );
  });

  it('is not confused by braces inside strings/comments within the block', async () => {
    const src = 'plugins {\n    // }\n    id \'a\' // {\n    id "}"\n}\nandroid {}\n';
    const { out } = await run(src);
    expect(out.startsWith(`plugins {\n    // }\n    id 'a' // {\n    id "}"\n}\n${BEGIN}`)).toBe(
      true,
    );
    expect(out.endsWith('android {}\n')).toBe(true);
  });

  it('handles a one-line plugins block', async () => {
    const src = "plugins { id 'x' }\nandroid {}\n";
    const { out } = await run(src);
    expect(out).toBe(`plugins { id 'x' }\n${GROOVY_LOADER('\n')}android {}\n`);
  });

  it('puts the loader after plugins when buildscript {} comes first', async () => {
    const src =
      "buildscript {\n    repositories { mavenCentral() }\n}\nplugins {\n    id 'a'\n}\nandroid {}\n";
    const { out } = await run(src);
    expect(out).toBe(
      `buildscript {\n    repositories { mavenCentral() }\n}\nplugins {\n    id 'a'\n}\n${GROOVY_LOADER('\n')}android {}\n`,
    );
  });

  it('handles nested braces inside plugins', async () => {
    const src =
      "plugins {\n    id 'a' apply(false)\n    alias(libs.plugins.x)\n    foo { bar { baz } }\n}\nandroid {}\n";
    const { out } = await run(src);
    expect(out).toBe(
      `plugins {\n    id 'a' apply(false)\n    alias(libs.plugins.x)\n    foo { bar { baz } }\n}\n${GROOVY_LOADER('\n')}android {}\n`,
    );
  });

  it('only matches a top-level plugins block, not a nested one', async () => {
    const src =
      "subprojects {\n    plugins {\n        id 'n'\n    }\n}\nplugins {\n    id 'a'\n}\nandroid {}\n";
    const { out } = await run(src);
    expect(out).toBe(
      `subprojects {\n    plugins {\n        id 'n'\n    }\n}\nplugins {\n    id 'a'\n}\n${GROOVY_LOADER('\n')}android {}\n`,
    );
  });

  it('keeps CRLF endings (whole result) and rolls back byte-exact', async () => {
    const src = "plugins {\r\n    id 'a'\r\n}\r\nandroid {}\r\n";
    const { out, restored } = await run(src);
    expect(out).toBe(`plugins {\r\n    id 'a'\r\n}\r\n${GROOVY_LOADER('\r\n')}android {}\r\n`);
    expect(restored).toBe(src);
  });

  it('plugins block as the last line without a trailing newline: rollback is byte-exact', async () => {
    for (const src of ["plugins { id 'a' }", "plugins { id 'a' }\r\n".slice(0, -2)]) {
      const { out, restored } = await run(src);
      expect(out.startsWith(`${src}\n${BEGIN}`)).toBe(true);
      expect(out.endsWith('loader:end')).toBe(true);
      expect(restored).toBe(src);
    }
  });

  it('CRLF file without a trailing newline uses CRLF for the separator', async () => {
    const src = "a\r\nplugins { id 'a' }";
    const { out, restored } = await run(src);
    expect(out.startsWith(`a\r\nplugins { id 'a' }\r\n${BEGIN}\r\n`)).toBe(true);
    expect(restored).toBe(src);
  });
});

describe('applyPluginStep', () => {
  beforeEach(async () => {
    fixture = await makeFixture({ 'app/build.gradle.kts': SAMPLE_KOTLIN_APP_BUILD });
  });

  it('adds the plugin id inside the plugins block', async () => {
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    expect(await applyPluginStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await applyPluginStep.apply(ctx);
    const updated = await readFixture(fixture, 'app/build.gradle.kts');
    expect(updated).toContain('id("com.bugsee.android.gradle") version "4.0.0-beta6"');
    expect(await applyPluginStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('rolls back by removing the plugin line', async () => {
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    await applyPluginStep.apply(ctx);
    await applyPluginStep.rollback(ctx);
    const updated = await readFixture(fixture, 'app/build.gradle.kts');
    expect(updated).not.toContain('com.bugsee.android.gradle');
  });

  it('uses Groovy syntax when the DSL is groovy', async () => {
    const dir = await makeFixture({ 'app/build.gradle': SAMPLE_GROOVY_APP_BUILD });
    const ctx = makeAndroidContext({ cwd: dir, dsl: 'groovy' });
    await applyPluginStep.apply(ctx);
    const updated = await readFixture(dir, 'app/build.gradle');
    expect(updated).toContain(`id 'com.bugsee.android.gradle' version '4.0.0-beta6'`);
    await cleanup(dir);
  });

  it('legacy-apply: appends apply plugin line after existing ones', async () => {
    const dir = await makeFixture({ 'app/build.gradle': SAMPLE_RN_APP_BUILD });
    const ctx = makeAndroidContext({ cwd: dir, dsl: 'groovy', style: 'legacy-apply' });
    expect(await applyPluginStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await applyPluginStep.apply(ctx);
    const updated = await readFixture(dir, 'app/build.gradle');
    expect(updated).toContain('apply plugin: "com.bugsee.android.gradle"');
    // Our line lands after the existing apply plugin lines, before `android {`
    const facebookIdx = updated.indexOf('apply plugin: "com.facebook.react"');
    const ourIdx = updated.indexOf('apply plugin: "com.bugsee.android.gradle"');
    const androidIdx = updated.indexOf('android {');
    expect(facebookIdx).toBeLessThan(ourIdx);
    expect(ourIdx).toBeLessThan(androidIdx);
    expect(await applyPluginStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await cleanup(dir);
  });

  it('legacy-apply: rolls back by stripping the marker block', async () => {
    const dir = await makeFixture({ 'app/build.gradle': SAMPLE_RN_APP_BUILD });
    const ctx = makeAndroidContext({ cwd: dir, dsl: 'groovy', style: 'legacy-apply' });
    const original = await readFixture(dir, 'app/build.gradle');
    await applyPluginStep.apply(ctx);
    await applyPluginStep.rollback(ctx);
    const restored = await readFixture(dir, 'app/build.gradle');
    expect(restored).toBe(original);
    await cleanup(dir);
  });

  it('legacy-apply + Kotlin DSL: emits apply(plugin = "…") syntax', async () => {
    const dir = await makeFixture({ 'app/build.gradle.kts': SAMPLE_KOTLIN_LEGACY_APP_BUILD });
    const ctx = makeAndroidContext({ cwd: dir, dsl: 'kotlin', style: 'legacy-apply' });
    expect(await applyPluginStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await applyPluginStep.apply(ctx);
    const updated = await readFixture(dir, 'app/build.gradle.kts');
    expect(updated).toContain('apply(plugin = "com.bugsee.android.gradle")');
    // Must NOT have written the Groovy form
    expect(updated).not.toContain('apply plugin: "com.bugsee.android.gradle"');
    // Lands after the last existing apply line, before `android {`
    const kotlinPluginIdx = updated.indexOf('apply(plugin = "org.jetbrains.kotlin.android")');
    const ourIdx = updated.indexOf('apply(plugin = "com.bugsee.android.gradle")');
    const androidIdx = updated.indexOf('android {');
    expect(kotlinPluginIdx).toBeLessThan(ourIdx);
    expect(ourIdx).toBeLessThan(androidIdx);
    expect(await applyPluginStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await cleanup(dir);
  });

  it('legacy-apply + Kotlin DSL: rolls back to original', async () => {
    const dir = await makeFixture({ 'app/build.gradle.kts': SAMPLE_KOTLIN_LEGACY_APP_BUILD });
    const ctx = makeAndroidContext({ cwd: dir, dsl: 'kotlin', style: 'legacy-apply' });
    const original = await readFixture(dir, 'app/build.gradle.kts');
    await applyPluginStep.apply(ctx);
    await applyPluginStep.rollback(ctx);
    const restored = await readFixture(dir, 'app/build.gradle.kts');
    expect(restored).toBe(original);
    await cleanup(dir);
  });
});

describe('addBuildscriptClasspathStep', () => {
  it('adds classpath line into project-level buildscript dependencies', async () => {
    const dir = await makeFixture({ 'build.gradle': SAMPLE_RN_PROJECT_BUILD });
    const ctx = makeAndroidContext({ cwd: dir, dsl: 'groovy', style: 'legacy-apply' });
    expect(await addBuildscriptClasspathStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await addBuildscriptClasspathStep.apply(ctx);
    const updated = await readFixture(dir, 'build.gradle');
    expect(updated).toContain(`classpath 'com.bugsee:bugsee-android-gradle-plugin:4.0.0-beta6'`);
    expect(await addBuildscriptClasspathStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await cleanup(dir);
  });

  it('rolls back to original project build.gradle', async () => {
    const dir = await makeFixture({ 'build.gradle': SAMPLE_RN_PROJECT_BUILD });
    const ctx = makeAndroidContext({ cwd: dir, dsl: 'groovy', style: 'legacy-apply' });
    const original = await readFixture(dir, 'build.gradle');
    await addBuildscriptClasspathStep.apply(ctx);
    await addBuildscriptClasspathStep.rollback(ctx);
    const restored = await readFixture(dir, 'build.gradle');
    expect(restored).toBe(original);
    await cleanup(dir);
  });

  it('blocks when there is no buildscript {} block', async () => {
    const dir = await makeFixture({ 'build.gradle': '// nothing here\n' });
    const ctx = makeAndroidContext({ cwd: dir, dsl: 'groovy', style: 'legacy-apply' });
    const status = await addBuildscriptClasspathStep.precheck(ctx);
    expect(status.kind).toBe('blocked');
    await cleanup(dir);
  });
});

describe('configureBugseeBlockStep', () => {
  beforeEach(async () => {
    fixture = await makeFixture({ 'app/build.gradle.kts': SAMPLE_KOTLIN_APP_BUILD });
  });

  it('appends an empty structural bugsee {} block when no opt-ins', async () => {
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    await configureBugseeBlockStep.apply(ctx);
    const updated = await readFixture(fixture, 'app/build.gradle.kts');
    // Token is not in the block — plugin reads bugsee.properties directly.
    expect(updated).not.toContain('appToken');
    expect(updated).toMatch(/bugsee\s*\{\s*\n\}/);
    expect(updated).not.toContain('ndk(true)');
    expect(updated).not.toContain('feedback(true)');
    expect(updated).not.toContain('sizeAnalysis');
  });

  it('emits sizeAnalysis sub-block when opted in (Kotlin)', async () => {
    const ctx = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      androidOptions: {
        initMode: 'automatic',
        ndk: false,
        feedback: false,
        sizeAnalysis: true,
      },
    });
    await configureBugseeBlockStep.apply(ctx);
    const updated = await readFixture(fixture, 'app/build.gradle.kts');
    expect(updated).toMatch(/sizeAnalysis\s*\{\s*\n\s*enabled\.set\(true\)\s*\n\s*\}/);
  });

  it('emits sizeAnalysis sub-block when opted in (Groovy)', async () => {
    const dir = await makeFixture({ 'app/build.gradle': SAMPLE_GROOVY_APP_BUILD });
    const ctx = makeAndroidContext({
      cwd: dir,
      dsl: 'groovy',
      androidOptions: {
        initMode: 'automatic',
        ndk: false,
        feedback: false,
        sizeAnalysis: true,
      },
    });
    await configureBugseeBlockStep.apply(ctx);
    const updated = await readFixture(dir, 'app/build.gradle');
    expect(updated).toMatch(/sizeAnalysis\s*\{\s*\n\s*enabled\.set\(true\)\s*\n\s*\}/);
    await cleanup(dir);
  });

  it('includes ndk(true) and feedback(true) when opted in', async () => {
    const ctx = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      androidOptions: {
        initMode: 'automatic',
        ndk: true,
        feedback: true,
        sizeAnalysis: false,
      },
    });
    await configureBugseeBlockStep.apply(ctx);
    const updated = await readFixture(fixture, 'app/build.gradle.kts');
    expect(updated).toContain('ndk(true)');
    expect(updated).toContain('feedback(true)');
  });

  it('rolls back by removing the marker block', async () => {
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    const original = await readFixture(fixture, 'app/build.gradle.kts');
    await configureBugseeBlockStep.apply(ctx);
    await configureBugseeBlockStep.rollback(ctx);
    const restored = await readFixture(fixture, 'app/build.gradle.kts');
    expect(restored).toBe(original);
  });

  it('uses Groovy syntax when the DSL is groovy', async () => {
    const dir = await makeFixture({ 'app/build.gradle': SAMPLE_GROOVY_APP_BUILD });
    const ctx = makeAndroidContext({
      cwd: dir,
      dsl: 'groovy',
      androidOptions: {
        initMode: 'automatic',
        ndk: true,
        feedback: false,
        sizeAnalysis: false,
      },
    });
    await configureBugseeBlockStep.apply(ctx);
    const updated = await readFixture(dir, 'app/build.gradle');
    // Token line is intentionally absent — plugin reads bugsee.properties.
    expect(updated).not.toContain('appToken');
    expect(updated).toContain('ndk true');
    expect(updated).not.toContain('feedback');
    await cleanup(dir);
  });
});

describe('injectManifestPlaceholderStep', () => {
  beforeEach(async () => {
    fixture = await makeFixture({ 'app/build.gradle.kts': SAMPLE_KOTLIN_APP_BUILD });
  });

  it('inserts manifestPlaceholders inside defaultConfig', async () => {
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    await injectManifestPlaceholderStep.apply(ctx);
    const updated = await readFixture(fixture, 'app/build.gradle.kts');
    expect(updated).toContain('manifestPlaceholders["bugseeAppToken"] = bugseeAppToken');
    // Must be inside defaultConfig block
    const dcStart = updated.indexOf('defaultConfig {');
    const dcEnd = updated.indexOf('}', dcStart);
    expect(updated.slice(dcStart, dcEnd)).toContain('manifestPlaceholders');
    expect(await injectManifestPlaceholderStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('rolls back to original', async () => {
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    const original = await readFixture(fixture, 'app/build.gradle.kts');
    await injectManifestPlaceholderStep.apply(ctx);
    await injectManifestPlaceholderStep.rollback(ctx);
    expect(await readFixture(fixture, 'app/build.gradle.kts')).toBe(original);
  });
});

describe('injectManifestMetaStep', () => {
  beforeEach(async () => {
    fixture = await makeFixture({ 'app/src/main/AndroidManifest.xml': SAMPLE_MANIFEST });
  });

  it('adds com.bugsee.app-token meta-data in automatic mode', async () => {
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    await injectManifestMetaStep.apply(ctx);
    const updated = await readFixture(fixture, 'app/src/main/AndroidManifest.xml');
    expect(updated).toContain('android:name="com.bugsee.app-token"');
    expect(updated).toContain('${bugseeAppToken}');
    expect(await injectManifestMetaStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('adds com.bugsee.auto-init=false meta-data in manual mode', async () => {
    const ctx = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      androidOptions: {
        initMode: 'manual',
        ndk: false,
        feedback: false,
        sizeAnalysis: false,
      },
    });
    await injectManifestMetaStep.apply(ctx);
    const updated = await readFixture(fixture, 'app/src/main/AndroidManifest.xml');
    expect(updated).toContain('android:name="com.bugsee.auto-init"');
    expect(updated).toContain('android:value="false"');
  });

  it('rolls back to original manifest', async () => {
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    const original = await readFixture(fixture, 'app/src/main/AndroidManifest.xml');
    await injectManifestMetaStep.apply(ctx);
    await injectManifestMetaStep.rollback(ctx);
    expect(await readFixture(fixture, 'app/src/main/AndroidManifest.xml')).toBe(original);
  });
});

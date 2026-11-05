import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runRollback, runSteps } from '../../src/core/step.js';
import {
  androidGradleSteps,
  stripOwn,
} from '../../src/recipes/react-native/steps/android-gradle.js';
import type { RnContext } from '../../src/recipes/react-native/types.js';
import {
  cleanup,
  makeFixture,
  makeRnContext,
  readFixture,
  SAMPLE_RN_PACKAGE_JSON,
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
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), error: vi.fn() }),
}));

const TOKEN = 'AND_TOK_SECRET_123';

// --- RN 0.74 bare template (Groovy), trimmed to the shape that matters -----------------------

const SETTINGS_074 = `pluginManagement { includeBuild("../node_modules/@react-native/gradle-plugin") }
plugins { id("com.facebook.react.settings") }
extensions.configure(com.facebook.react.ReactSettingsExtension){ ex -> ex.autolinkLibrariesFromCommand() }
rootProject.name = 'AwesomeProject'
include ':app'
includeBuild('../node_modules/@react-native/gradle-plugin')
`;

const ROOT_074 = `// Top-level build file where you can add configuration options common to all sub-projects/modules.

buildscript {
    ext {
        buildToolsVersion = "34.0.0"
        minSdkVersion = 23
    }
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle")
        classpath("com.facebook.react:react-native-gradle-plugin")
    }
}

apply plugin: "com.facebook.react.rootproject"
`;

const APP_074 = `apply plugin: "com.android.application"
apply plugin: "org.jetbrains.kotlin.android"
apply plugin: "com.facebook.react"

/**
 * This is the configuration block to customize your React Native Android app.
 */
react {
    /* Folders */
    //   The root of your project, i.e. where "package.json" lives. Default is '../..'
    // root = file("../../")

    /* Hermes Commands */
    //   The hermes compiler command to run. By default it is 'hermesc'
    // hermesCommand = "$rootDir/my-custom-hermesc/bin/hermesc"
    //
    //   The list of flags to pass to the Hermes compiler. By default is "-O", "-output-source-map"
    // hermesFlags = ["-O", "-output-source-map"]
}

def enableProguardInReleaseBuilds = false
def jscFlavor = 'org.webkit:android-jsc:+'

android {
    namespace "com.awesomeproject"
    defaultConfig {
        applicationId "com.awesomeproject"
    }
    buildTypes {
        release {
            minifyEnabled enableProguardInReleaseBuilds
        }
    }
}

dependencies {
    // The version of react-native is set by the React Native Gradle Plugin
    implementation("com.facebook.react:react-android")

    if (hermesEnabled.toBoolean()) {
        implementation("com.facebook.react:hermes-android")
    } else {
        implementation jscFlavor
    }
}

apply from: file("../../node_modules/@react-native-community/cli-platform-android/native_modules.gradle"); applyNativeModulesAppBuildGradle(project)
`;

// --- Kotlin DSL shapes ------------------------------------------------------------------------

const SETTINGS_KTS = `pluginManagement {
    includeBuild("../node_modules/@react-native/gradle-plugin")
}
plugins { id("com.facebook.react.settings") }
rootProject.name = "AwesomeProject"
include(":app")
`;

const ROOT_KTS = `buildscript {
    repositories {
        google()
        mavenCentral()
    }
}

apply(plugin = "com.facebook.react.rootproject")
`;

const APP_KTS = `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.facebook.react")
}

react {
    // hermesCommand.set("x")
    autolinkLibrariesWithApp()
}

android {
    namespace = "com.awesomeproject"
}

dependencies {
    implementation("com.facebook.react:react-android")
}
`;

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) await cleanup(fixture);
  fixture = undefined;
});

interface Shape {
  settings?: string;
  settingsName?: string;
  root?: string;
  rootName?: string;
  app?: string;
  appName?: string;
  extra?: Record<string, string>;
}

async function setup(
  shape: Shape = {},
  tokens: Record<string, string> | undefined = { android: TOKEN },
): Promise<RnContext> {
  const files: Record<string, string> = {
    'package.json': SAMPLE_RN_PACKAGE_JSON,
    [`android/${shape.settingsName ?? 'settings.gradle'}`]: shape.settings ?? SETTINGS_074,
    [`android/${shape.rootName ?? 'build.gradle'}`]: shape.root ?? ROOT_074,
    [`android/app/${shape.appName ?? 'build.gradle'}`]: shape.app ?? APP_074,
    ...(shape.extra ?? {}),
  };
  fixture = await makeFixture(files);
  return makeRnContext({ cwd: fixture, ...(tokens ? { tokens } : {}) });
}

const byId = (id: string) => {
  const step = androidGradleSteps.find((s) => s.id === id);
  if (!step) throw new Error(`no step ${id}`);
  return step;
};
const SETTINGS = 'rn.android.settings-gradle';
const ROOT = 'rn.android.root-gradle';
const APP = 'rn.android.app-gradle';
const IGNORE = 'rn.android.gitignore';
const PROPS = 'rn.android.bugsee-properties';

async function exists(rel: string): Promise<boolean> {
  try {
    await stat(path.join(fixture as string, rel));
    return true;
  } catch {
    return false;
  }
}

async function applyOne(id: string, ctx: RnContext) {
  return byId(id).apply(ctx);
}

describe('exports', () => {
  it('lists the five steps in token-safe order (gitignore before properties)', () => {
    expect(androidGradleSteps.map((s) => s.id)).toEqual([SETTINGS, ROOT, APP, IGNORE, PROPS]);
  });
});

describe('full run on an RN 0.74 bare template', () => {
  it('applies every edit, is idempotent, and rolls back to the original bytes', async () => {
    const ctx = await setup();
    const res = await runSteps(androidGradleSteps, ctx);
    expect(res.failed).toBe(false);
    expect(res.incomplete).toBe(false);
    expect(res.results.map((r) => r.outcome)).toEqual(Array(5).fill('applied'));

    const settings = await readFixture(fixture as string, 'android/settings.gradle');
    expect(settings).toContain('mavenCentral()');
    expect(settings).toContain('gradlePluginPortal()');
    expect(settings).toContain('google()');
    // the existing include is kept verbatim inside the expanded block
    expect(settings).toContain('includeBuild("../node_modules/@react-native/gradle-plugin")');
    expect(settings).toContain("includeBuild('../node_modules/@react-native/gradle-plugin')");

    const root = await readFixture(fixture as string, 'android/build.gradle');
    expect(root).toContain("id 'com.bugsee.android.gradle' version '4.0.8' apply false");
    expect(root.indexOf('plugins {')).toBeGreaterThan(root.indexOf('buildscript {'));
    expect(root.indexOf('plugins {')).toBeLessThan(
      root.indexOf('apply plugin: "com.facebook.react.rootproject"'),
    );

    const app = await readFixture(fixture as string, 'android/app/build.gradle');
    const lines = app.split('\n');
    expect(
      lines.indexOf('apply plugin: "com.bugsee.android.gradle" // bugsee:wizard:rn-gradle:line'),
    ).toBe(3);
    expect(app).toContain('def bugseeDir = new File(["node", "--print", "require.resolve(');
    expect(app).toContain('hermesc-preserve-js.cmd" : "hermesc-preserve-js.sh"');
    expect(app).toContain(
      'implementation "com.bugsee:bugsee-android-ndk:${bugseeVersions.android.sdk}"',
    );
    expect(app.trimEnd().split('\n').at(-2)).toContain(
      'apply from: new File(new File(bugseeDir, "scripts"), "bugsee-sourcemaps.gradle")',
    );
    // bugseeDir is defined before the react block that uses it
    expect(app.indexOf('def bugseeDir')).toBeLessThan(app.indexOf('react {'));
    // the user's own text is untouched
    expect(app).toContain('// hermesCommand = "$rootDir/my-custom-hermesc/bin/hermesc"');
    expect(app).toContain('applyNativeModulesAppBuildGradle(project)');

    expect(await readFixture(fixture as string, 'android/bugsee.properties')).toBe(
      `# bugsee:wizard:rn-gradle:begin\napp_token=${TOKEN}\nplugin.ndk.enabled=true\n# bugsee:wizard:rn-gradle:end\n`,
    );
    expect(await readFixture(fixture as string, 'android/.gitignore')).toContain(
      'bugsee.properties',
    );

    // idempotent: every precheck is satisfied, nothing changes
    const before = await Promise.all(
      [
        'settings.gradle',
        'build.gradle',
        'app/build.gradle',
        'bugsee.properties',
        '.gitignore',
      ].map((f) => readFixture(fixture as string, `android/${f}`)),
    );
    const again = await runSteps(androidGradleSteps, ctx);
    expect(again.results.map((r) => r.outcome)).toEqual(Array(5).fill('skipped'));
    const after = await Promise.all(
      [
        'settings.gradle',
        'build.gradle',
        'app/build.gradle',
        'bugsee.properties',
        '.gitignore',
      ].map((f) => readFixture(fixture as string, `android/${f}`)),
    );
    expect(after).toEqual(before);

    // rollback restores the exact bytes; files we created are gone
    const rb = await runRollback(androidGradleSteps, ctx);
    expect(rb.failed).toBe(false);
    expect(await readFixture(fixture as string, 'android/settings.gradle')).toBe(SETTINGS_074);
    expect(await readFixture(fixture as string, 'android/build.gradle')).toBe(ROOT_074);
    expect(await readFixture(fixture as string, 'android/app/build.gradle')).toBe(APP_074);
    expect(await exists('android/bugsee.properties')).toBe(false);
    expect(await exists('android/.gitignore')).toBe(false);
  });

  it('never writes the token anywhere but bugsee.properties', async () => {
    const ctx = await setup();
    await runSteps(androidGradleSteps, ctx);
    for (const f of ['settings.gradle', 'build.gradle', 'app/build.gradle', '.gitignore']) {
      expect(await readFixture(fixture as string, `android/${f}`)).not.toContain(TOKEN);
    }
  });

  it('uses the pinned versions from the context, not hard-coded ones', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'android/settings.gradle': SETTINGS_074,
      'android/build.gradle': ROOT_074,
      'android/app/build.gradle': APP_KTS.replace('plugins {', 'plugins {'),
    });
    const ctx = {
      ...(await makeRnContext({ cwd: fixture, tokens: { android: TOKEN } })),
    } as RnContext;
    const custom: RnContext = {
      ...ctx,
      rnOptions: {
        ...ctx.rnOptions,
        nativeVersions: { androidSdk: '9.9.9', androidGradlePlugin: '8.8.8', iosSdk: '1.0.0' },
      },
    };
    await applyOne(ROOT, custom);
    expect(await readFixture(fixture, 'android/build.gradle')).toContain("version '8.8.8'");
  });
});

describe('no work to do', () => {
  it('every step is satisfied with a note when there is no Android token', async () => {
    const ctx = await setup({}, {});
    for (const step of androidGradleSteps) {
      const st = await step.precheck(ctx);
      expect(st).toEqual({ kind: 'satisfied', note: 'no Android app token' });
    }
  });

  it('every step is satisfied with a note when there is no android/ directory', async () => {
    fixture = await makeFixture({ 'package.json': SAMPLE_RN_PACKAGE_JSON });
    const ctx = await makeRnContext({ cwd: fixture, tokens: { android: TOKEN } });
    for (const step of androidGradleSteps) {
      expect(await step.precheck(ctx)).toEqual({
        kind: 'satisfied',
        note: 'no android/ directory',
      });
      await step.rollback(ctx); // no-op, must not throw
    }
  });

  it('a dry run changes nothing', async () => {
    const ctx = await setup();
    const res = await runSteps(androidGradleSteps, { ...ctx, dryRun: true });
    expect(res.results.map((r) => r.outcome)).toEqual(Array(5).fill('applied'));
    expect(await readFixture(fixture as string, 'android/settings.gradle')).toBe(SETTINGS_074);
    expect(await readFixture(fixture as string, 'android/app/build.gradle')).toBe(APP_074);
    expect(await exists('android/bugsee.properties')).toBe(false);
  });
});

describe('settings.gradle', () => {
  it('prepends a pluginManagement block when there is none, and removes it on rollback', async () => {
    const original = `rootProject.name = 'X'\ninclude ':app'\n`;
    const ctx = await setup({ settings: original });
    await applyOne(SETTINGS, ctx);
    const out = await readFixture(fixture as string, 'android/settings.gradle');
    expect(out.startsWith('// bugsee:wizard:rn-gradle:begin\npluginManagement {')).toBe(true);
    expect(out).toContain("rootProject.name = 'X'");
    await byId(SETTINGS).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/settings.gradle')).toBe(original);
  });

  it('adds only mavenCentral() to an existing repositories block', async () => {
    const original = `pluginManagement {
    includeBuild("../node_modules/@react-native/gradle-plugin")
    repositories {
        google()
        gradlePluginPortal()
    }
}
include ':app'
`;
    const ctx = await setup({ settings: original });
    await applyOne(SETTINGS, ctx);
    const out = await readFixture(fixture as string, 'android/settings.gradle');
    expect(out).toContain(
      '        gradlePluginPortal()\n        mavenCentral() // bugsee:wizard:rn-gradle:line\n    }',
    );
    expect(out.match(/google\(\)/g)).toHaveLength(1);
    await byId(SETTINGS).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/settings.gradle')).toBe(original);
  });

  it('adds a repositories block to a multi-line pluginManagement without one', async () => {
    const ctx = await setup({ settings: SETTINGS_KTS, settingsName: 'settings.gradle.kts' });
    await applyOne(SETTINGS, ctx);
    const out = await readFixture(fixture as string, 'android/settings.gradle.kts');
    expect(out).toContain(
      '    // bugsee:wizard:rn-gradle:begin\n    repositories {\n        gradlePluginPortal()',
    );
    expect(out).toContain('includeBuild("../node_modules/@react-native/gradle-plugin")');
    await byId(SETTINGS).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/settings.gradle.kts')).toBe(SETTINGS_KTS);
  });

  it('leaves a file that already searches mavenCentral alone (satisfied)', async () => {
    const s = `pluginManagement {\n    repositories {\n        mavenCentral()\n    }\n}\n`;
    const ctx = await setup({ settings: s });
    expect((await byId(SETTINGS).precheck(ctx)).kind).toBe('satisfied');
    const one = `pluginManagement { repositories { mavenCentral() } }\n`;
    const ctx2 = await setup({ settings: one });
    expect((await byId(SETTINGS).precheck(ctx2)).kind).toBe('satisfied');
  });

  it('ignores mavenCentral mentioned only in comments or strings', async () => {
    const s = `pluginManagement {\n    // mavenCentral() later\n    includeBuild("x") // "mavenCentral()"\n}\n`;
    const ctx = await setup({ settings: s });
    expect((await byId(SETTINGS).precheck(ctx)).kind).toBe('pending');
  });

  it('hands back a manual snippet for an inline repositories block', async () => {
    const s = `pluginManagement { repositories { google() } }\n`;
    const ctx = await setup({ settings: s });
    const res = await applyOne(SETTINGS, ctx);
    expect(res?.manual?.file).toBe(path.join('android', 'settings.gradle'));
    expect(res?.manual?.code).toContain('mavenCentral()');
    expect(await readFixture(fixture as string, 'android/settings.gradle')).toBe(s);
  });

  it('hands back a manual snippet when braces share a line with code', async () => {
    const s = `pluginManagement { includeBuild("a")\n}\n`;
    const ctx = await setup({ settings: s });
    expect((await applyOne(SETTINGS, ctx))?.manual).toBeDefined();
  });

  it('puts the new block after leading imports', async () => {
    const s = `import java.util.Locale\nrootProject.name = 'X'\n`;
    const ctx = await setup({ settings: s, settingsName: 'settings.gradle.kts' });
    await applyOne(SETTINGS, ctx);
    const out = await readFixture(fixture as string, 'android/settings.gradle.kts');
    expect(out.startsWith('import java.util.Locale\n// bugsee:wizard:rn-gradle:begin\n')).toBe(
      true,
    );
  });
});

describe('root build.gradle', () => {
  it('declares the plugin in a new plugins block after buildscript, with the pinned version', async () => {
    const ctx = await setup();
    await applyOne(ROOT, ctx);
    const out = await readFixture(fixture as string, 'android/build.gradle');
    expect(out).toContain(
      "}\n// bugsee:wizard:rn-gradle:begin\nplugins {\n    id 'com.bugsee.android.gradle' version '4.0.8' apply false\n}\n// bugsee:wizard:rn-gradle:end\n\napply plugin",
    );
  });

  it('adds to an existing plugins block as one marked line', async () => {
    const original = `buildscript {\n}\nplugins {\n    id 'foo.bar' version '1' apply false\n}\napply plugin: "x"\n`;
    const ctx = await setup({ root: original });
    await applyOne(ROOT, ctx);
    const out = await readFixture(fixture as string, 'android/build.gradle');
    expect(out).toContain(
      "    id 'foo.bar' version '1' apply false\n    id 'com.bugsee.android.gradle' version '4.0.8' apply false // bugsee:wizard:rn-gradle:line\n}",
    );
    await byId(ROOT).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/build.gradle')).toBe(original);
  });

  it('is satisfied when the plugin is already declared (any form), version untouched', async () => {
    const declared = `plugins {\n    id 'com.bugsee.android.gradle' version '3.0.0' apply false\n}\n`;
    const ctx = await setup({ root: declared });
    expect((await byId(ROOT).precheck(ctx)).kind).toBe('satisfied');
  });

  it('does not count the id in a comment as declared', async () => {
    const ctx = await setup({ root: `// id 'com.bugsee.android.gradle'\nbuildscript {\n}\n` });
    expect((await byId(ROOT).precheck(ctx)).kind).toBe('pending');
  });

  it('writes the Kotlin form into build.gradle.kts', async () => {
    const ctx = await setup({ root: ROOT_KTS, rootName: 'build.gradle.kts' });
    await applyOne(ROOT, ctx);
    const out = await readFixture(fixture as string, 'android/build.gradle.kts');
    expect(out).toContain('id("com.bugsee.android.gradle") version "4.0.8" apply false');
    await byId(ROOT).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/build.gradle.kts')).toBe(ROOT_KTS);
  });

  it('puts the block at the top when there is no buildscript', async () => {
    const ctx = await setup({ root: `apply plugin: "x"\n` });
    await applyOne(ROOT, ctx);
    const out = await readFixture(fixture as string, 'android/build.gradle');
    expect(out.startsWith('// bugsee:wizard:rn-gradle:begin\nplugins {')).toBe(true);
  });

  it('refuses (manual) a one-line plugins block, and an invalid pinned version', async () => {
    const ctx = await setup({ root: `plugins { id 'a' }\n` });
    const res = await applyOne(ROOT, ctx);
    expect(res?.manual?.code).toContain(
      "id 'com.bugsee.android.gradle' version '4.0.8' apply false",
    );
    const bad: RnContext = {
      ...ctx,
      rnOptions: {
        ...ctx.rnOptions,
        nativeVersions: { ...ctx.rnOptions.nativeVersions, androidGradlePlugin: "1'; evil" },
      },
    };
    const res2 = await applyOne(ROOT, bad);
    expect(res2?.manual).toBeDefined();
  });
});

describe('app/build.gradle (Groovy)', () => {
  it('rewrites a live one-line hermesCommand, keeps its trailing comment, restores it on rollback', async () => {
    const app = APP_074.replace(
      '    /* Hermes Commands */',
      '    hermesCommand = "$rootDir/hermesc" // custom\n    /* Hermes Commands */',
    );
    const ctx = await setup({ app });
    await applyOne(APP, ctx);
    const out = await readFixture(fixture as string, 'android/app/build.gradle');
    expect(out).toContain(
      '    // bugsee:wizard:rn-gradle:orig:1 hermesCommand = "$rootDir/hermesc" // custom',
    );
    expect(out).toMatch(
      /\n {4}hermesCommand = new File\(new File\(bugseeDir.*absolutePath \/\/ custom\n/,
    );
    expect(out).not.toContain('\n    hermesCommand = "$rootDir/hermesc"');
    await byId(APP).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/app/build.gradle')).toBe(app);
  });

  it('rewrites a hermesCommand.set(...) call as an assignment', async () => {
    const app = APP_074.replace('    /* Hermes Commands */', '    hermesCommand.set("x")\n');
    const ctx = await setup({ app });
    await applyOne(APP, ctx);
    const out = await readFixture(fixture as string, 'android/app/build.gradle');
    expect(out).toMatch(/\n {4}hermesCommand = new File\(/);
    expect(out).not.toContain('hermesCommand.set("x")\n    //');
    await byId(APP).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/app/build.gradle')).toBe(app);
  });

  it('keeps a hermesCommand that already names hermesc-preserve-js', async () => {
    const own = '    hermesCommand = "$rootDir/mine/hermesc-preserve-js.sh"\n';
    const app = APP_074.replace('    /* Hermes Commands */', `${own}    /* Hermes Commands */`);
    const ctx = await setup({ app });
    await applyOne(APP, ctx);
    const out = await readFixture(fixture as string, 'android/app/build.gradle');
    expect(out).toContain(own);
    expect(out.match(/hermesCommand = /g)).toHaveLength(2); // the user's + the commented one
    expect(out).not.toContain('orig:');
  });

  it('refuses a hermesCommand that spans lines, shares its line, or is another statement', async () => {
    for (const bad of [
      '    hermesCommand = file("a") +\n        "b"\n',
      '    hermesCommand = "a"; println "x"\n',
      '    hermesCommand =\n',
      '    hermesCommand = file(\n        "a")\n',
      '    hermesCommand = cond\n        ? "a" : "b"\n',
    ]) {
      const app = APP_074.replace('    /* Hermes Commands */', `${bad}    /* Hermes Commands */`);
      const ctx = await setup({ app });
      const res = await applyOne(APP, ctx);
      expect(res?.manual, bad).toBeDefined();
      expect(await readFixture(fixture as string, 'android/app/build.gradle')).toBe(app);
      await cleanup(fixture as string);
    }
  });

  it('only counts hermesCommand at the top level of the react block', async () => {
    const app = APP_074.replace(
      '    /* Hermes Commands */',
      '    other {\n        hermesCommand = "inner"\n    }\n    /* Hermes Commands */',
    );
    const ctx = await setup({ app });
    await applyOne(APP, ctx);
    const out = await readFixture(fixture as string, 'android/app/build.gradle');
    expect(out).toContain('        hermesCommand = "inner"');
    expect(out).toContain('hermesCommand = new File(new File(bugseeDir');
  });

  it('adds a react block when the file has none', async () => {
    const app = APP_074.replace(/react \{[\s\S]*?\n\}\n/, '');
    expect(app).not.toMatch(/^react \{/m);
    const ctx = await setup({ app });
    await applyOne(APP, ctx);
    const out = await readFixture(fixture as string, 'android/app/build.gradle');
    expect(out).toMatch(
      /\/\/ bugsee:wizard:rn-gradle:begin\nreact \{\n {4}hermesCommand = new File/,
    );
    expect(out.indexOf('def bugseeDir')).toBeLessThan(out.indexOf('react {'));
    await byId(APP).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/app/build.gradle')).toBe(app);
  });

  it('defines bugseeDir before a react block that precedes the plugin apply anchor', async () => {
    const app = `react {\n}\napply plugin: "com.facebook.react"\n`;
    const ctx = await setup({ app });
    await applyOne(APP, ctx);
    const out = await readFixture(fixture as string, 'android/app/build.gradle');
    expect(out.indexOf('def bugseeDir')).toBeLessThan(out.indexOf('react {'));
  });

  it('skips pieces the user already has: plugin, bugseeDir, ndk dependency, sourcemaps hook', async () => {
    const app = `apply plugin: "com.facebook.react"
apply plugin: "com.bugsee.android.gradle"
def bugseeDir = file("x")
react {
    hermesCommand = new File(bugseeDir, "scripts/hermesc-preserve-js.sh").absolutePath
}
dependencies {
    implementation "com.bugsee:bugsee-android-ndk:1.2.3"
}
apply from: new File(bugseeDir, "scripts/bugsee-sourcemaps.gradle")
`;
    const ctx = await setup({ app });
    expect((await byId(APP).precheck(ctx)).kind).toBe('satisfied');
  });

  it('adds only what is missing and strips only that', async () => {
    const app = `apply plugin: "com.facebook.react"
def bugseeDir = file("x")
react {
    hermesCommand = new File(bugseeDir, "scripts/hermesc-preserve-js.sh").absolutePath
}
dependencies {
    implementation "com.bugsee:bugsee-android-ndk:1.2.3"
}
`;
    const ctx = await setup({ app });
    await applyOne(APP, ctx);
    const out = await readFixture(fixture as string, 'android/app/build.gradle');
    expect(out).toContain('apply plugin: "com.bugsee.android.gradle"');
    expect(out).toContain('bugsee-sourcemaps.gradle');
    expect(out.match(/def bugseeDir/g)).toHaveLength(1);
    expect(out.match(/bugsee-android-ndk/g)).toHaveLength(1);
    expect(out).not.toContain('bugseeVersions');
    await byId(APP).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/app/build.gradle')).toBe(app);
  });

  it('inserts into a plugins { } block when the app uses one (Groovy)', async () => {
    const app = `plugins {\n    id 'com.android.application'\n    id 'com.facebook.react'\n}\nreact {\n}\n`;
    const ctx = await setup({ app });
    await applyOne(APP, ctx);
    const out = await readFixture(fixture as string, 'android/app/build.gradle');
    expect(out).toContain("    id 'com.bugsee.android.gradle' // bugsee:wizard:rn-gradle:line\n}");
    await byId(APP).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/app/build.gradle')).toBe(app);
  });

  it('returns manual for a legacy (RN 0.70) app file with no anchor', async () => {
    const app = `apply plugin: "com.android.application"\nproject.ext.react = [\n  enableHermes: true\n]\napply from: "../../node_modules/react-native/react.gradle"\n`;
    const ctx = await setup({ app });
    const res = await applyOne(APP, ctx);
    expect(res?.manual?.file).toBe(path.join('android', 'app', 'build.gradle'));
    expect(res?.manual?.code).toContain('apply plugin: "com.bugsee.android.gradle"');
    expect(res?.manual?.code).toContain('bugsee-android-ndk:${bugseeVersions.android.sdk}');
    expect(res?.manual?.code).not.toContain(TOKEN);
    expect(await readFixture(fixture as string, 'android/app/build.gradle')).toBe(app);
    expect(res?.applied).toBeUndefined();
  });

  it('refuses a one-line react block', async () => {
    const app = `apply plugin: "com.facebook.react"\nreact { autolinkLibrariesWithApp() }\n`;
    const ctx = await setup({ app });
    expect((await applyOne(APP, ctx))?.manual).toBeDefined();
  });

  it('returns manual (not an error) when app/build.gradle is missing', async () => {
    const ctx = await setup();
    await (await import('node:fs/promises')).rm(
      path.join(fixture as string, 'android/app/build.gradle'),
    );
    expect((await byId(APP).precheck(ctx)).kind).toBe('pending');
    const res = await applyOne(APP, ctx);
    expect(res?.manual?.file).toBe(path.join('android', 'app', 'build.gradle'));
    await byId(APP).rollback(ctx); // nothing to strip, no throw
  });

  it('braces inside comments and strings do not confuse block detection', async () => {
    const app = `apply plugin: "com.facebook.react"
// react { fake
def s = "}" + '{' + """ } {{ """
/* react {
*/
react {
    // }
    def t = "\${x}"
}
`;
    const ctx = await setup({ app });
    await applyOne(APP, ctx);
    const out = await readFixture(fixture as string, 'android/app/build.gradle');
    expect(out).toContain('react {\n    hermesCommand = new File(new File(bugseeDir');
    await byId(APP).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/app/build.gradle')).toBe(app);
  });

  it('restores bytes for a file without a trailing newline, and CRLF files', async () => {
    const unterminated = APP_074.trimEnd();
    const ctx = await setup({ app: unterminated });
    await applyOne(APP, ctx);
    const out = await readFixture(fixture as string, 'android/app/build.gradle');
    expect(out.endsWith('\n')).toBe(false);
    expect((await byId(APP).precheck(ctx)).kind).toBe('satisfied');
    await byId(APP).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/app/build.gradle')).toBe(unterminated);
    await cleanup(fixture as string);

    const crlf = APP_074.replace(/\n/g, '\r\n');
    const ctx2 = await setup({ app: crlf, settings: SETTINGS_074.replace(/\n/g, '\r\n') });
    await applyOne(SETTINGS, ctx2);
    await applyOne(APP, ctx2);
    const out2 = await readFixture(fixture as string, 'android/app/build.gradle');
    expect(out2.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect((await byId(APP).precheck(ctx2)).kind).toBe('satisfied');
    await byId(APP).rollback(ctx2);
    await byId(SETTINGS).rollback(ctx2);
    expect(await readFixture(fixture as string, 'android/app/build.gradle')).toBe(crlf);
    expect(await readFixture(fixture as string, 'android/settings.gradle')).toBe(
      SETTINGS_074.replace(/\n/g, '\r\n'),
    );
  });
});

describe('app/build.gradle.kts (Kotlin DSL)', () => {
  it('applies the README Kotlin edits and rolls back', async () => {
    const ctx = await setup({ app: APP_KTS, appName: 'build.gradle.kts' });
    await applyOne(APP, ctx);
    const out = await readFixture(fixture as string, 'android/app/build.gradle.kts');
    expect(out).toContain('    id("com.bugsee.android.gradle") // bugsee:wizard:rn-gradle:line\n}');
    expect(out).toContain('val bugseeDir = File(');
    expect(out).toContain(
      'hermesCommand.set(File(File(bugseeDir, "scripts"), if (System.getProperty',
    );
    expect(out).toContain('implementation("com.bugsee:bugsee-android-ndk:7.4.2")');
    expect(out).toContain(
      'apply(from = File(File(bugseeDir, "scripts"), "bugsee-sourcemaps.gradle"))',
    );
    expect(out.indexOf('val bugseeDir')).toBeGreaterThan(out.indexOf('id("com.facebook.react")'));
    expect(out.indexOf('val bugseeDir')).toBeLessThan(out.indexOf('react {'));
    expect((await byId(APP).precheck(ctx)).kind).toBe('satisfied');
    await byId(APP).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/app/build.gradle.kts')).toBe(APP_KTS);
  });

  it('rewrites an existing Kotlin hermesCommand.set(...) one-liner', async () => {
    const app = APP_KTS.replace(
      '    // hermesCommand.set("x")',
      '    hermesCommand.set("x") // mine',
    );
    const ctx = await setup({ app, appName: 'build.gradle.kts' });
    await applyOne(APP, ctx);
    const out = await readFixture(fixture as string, 'android/app/build.gradle.kts');
    expect(out).toMatch(
      / {4}hermesCommand\.set\(File\(File\(bugseeDir.*absolutePath\) \/\/ mine\n/,
    );
    await byId(APP).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/app/build.gradle.kts')).toBe(app);
  });

  it('returns Kotlin manual when there is no plugins block', async () => {
    const app = `apply(plugin = "com.facebook.react")\nreact {\n}\n`;
    const ctx = await setup({ app, appName: 'build.gradle.kts' });
    const res = await applyOne(APP, ctx);
    expect(res?.manual?.file).toBe(path.join('android', 'app', 'build.gradle.kts'));
    expect(res?.manual?.code).toContain('hermesCommand.set(');
    expect(res?.manual?.code).toContain('id("com.bugsee.android.gradle")');
    expect(res?.manual?.code).toContain('bugsee-android-ndk:7.4.2');
  });

  it('full Kotlin run: settings, root, app, then idempotent and byte-exact rollback', async () => {
    const ctx = await setup({
      settings: SETTINGS_KTS,
      settingsName: 'settings.gradle.kts',
      root: ROOT_KTS,
      rootName: 'build.gradle.kts',
      app: APP_KTS,
      appName: 'build.gradle.kts',
    });
    const res = await runSteps(androidGradleSteps, ctx);
    expect(res.results.map((r) => r.outcome)).toEqual(Array(5).fill('applied'));
    const again = await runSteps(androidGradleSteps, ctx);
    expect(again.results.map((r) => r.outcome)).toEqual(Array(5).fill('skipped'));
    await runRollback(androidGradleSteps, ctx);
    expect(await readFixture(fixture as string, 'android/settings.gradle.kts')).toBe(SETTINGS_KTS);
    expect(await readFixture(fixture as string, 'android/build.gradle.kts')).toBe(ROOT_KTS);
    expect(await readFixture(fixture as string, 'android/app/build.gradle.kts')).toBe(APP_KTS);
  });
});

describe('bugsee.properties and .gitignore', () => {
  it('creates the file with a marked block and deletes it on rollback', async () => {
    const ctx = await setup();
    await applyOne(PROPS, ctx);
    expect(await readFixture(fixture as string, 'android/bugsee.properties')).toContain(
      `app_token=${TOKEN}\n`,
    );
    await byId(PROPS).rollback(ctx);
    expect(await exists('android/bugsee.properties')).toBe(false);
  });

  it('appends to an existing file and strips only its own lines', async () => {
    const original = '# mine\nplugin.endpoint=https://x.example\n';
    const ctx = await setup({ extra: { 'android/bugsee.properties': original } });
    await applyOne(PROPS, ctx);
    const out = await readFixture(fixture as string, 'android/bugsee.properties');
    expect(out.startsWith(original)).toBe(true);
    expect(out).toContain(`app_token=${TOKEN}`);
    expect(out).toContain('plugin.ndk.enabled=true');
    await byId(PROPS).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/bugsee.properties')).toBe(original);
  });

  it('replaces a different stored token and restores the old one on rollback', async () => {
    const original = 'app_token=OLD\nplugin.ndk.enabled=true\n';
    const ctx = await setup({ extra: { 'android/bugsee.properties': original } });
    expect((await byId(PROPS).precheck(ctx)).kind).toBe('pending');
    await applyOne(PROPS, ctx);
    const out = await readFixture(fixture as string, 'android/bugsee.properties');
    expect(out).toContain(`app_token=${TOKEN}`);
    expect(out).not.toMatch(/^app_token=OLD$/m);
    expect((await byId(PROPS).precheck(ctx)).kind).toBe('satisfied');
    await byId(PROPS).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/bugsee.properties')).toBe(original);
  });

  it('is satisfied when token and ndk flag are present; pending when the ndk key is missing', async () => {
    const ctx = await setup({
      extra: { 'android/bugsee.properties': `app_token = ${TOKEN}\nplugin.ndk.enabled=false\n` },
    });
    expect((await byId(PROPS).precheck(ctx)).kind).toBe('satisfied');
    await cleanup(fixture as string);
    const ctx2 = await setup({ extra: { 'android/bugsee.properties': `app_token=${TOKEN}\n` } });
    expect((await byId(PROPS).precheck(ctx2)).kind).toBe('pending');
    await applyOne(PROPS, ctx2);
    expect(await readFixture(fixture as string, 'android/bugsee.properties')).toContain(
      'plugin.ndk.enabled=true',
    );
  });

  it('appends after an unterminated properties file and restores it', async () => {
    const original = '# mine';
    const ctx = await setup({ extra: { 'android/bugsee.properties': original } });
    await applyOne(PROPS, ctx);
    await byId(PROPS).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/bugsee.properties')).toBe(original);
  });

  it('refuses a token with a line break', async () => {
    const ctx = await setup({}, { android: 'a\nb' });
    await expect(applyOne(PROPS, ctx)).rejects.toThrow(/line break/);
    expect(await exists('android/bugsee.properties')).toBe(false);
  });

  it('gitignore: appends a marked block to android/.gitignore, preserving the rest', async () => {
    const original = '*.log\nbuild/';
    const ctx = await setup({ extra: { 'android/.gitignore': original } });
    expect((await byId(IGNORE).precheck(ctx)).kind).toBe('pending');
    await applyOne(IGNORE, ctx);
    expect(await readFixture(fixture as string, 'android/.gitignore')).toBe(
      `${original}\n# bugsee:wizard:rn-gradle:begin\nbugsee.properties\n# bugsee:wizard:rn-gradle:end`,
    );
    expect((await byId(IGNORE).precheck(ctx)).kind).toBe('satisfied');
    await byId(IGNORE).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/.gitignore')).toBe(original);
  });

  it('gitignore: already ignored in android/.gitignore or the project .gitignore', async () => {
    for (const [file, line] of [
      ['android/.gitignore', 'bugsee.properties'],
      ['android/.gitignore', '/bugsee.properties'],
      ['.gitignore', 'android/bugsee.properties'],
      ['.gitignore', '**/bugsee.properties'],
    ] as const) {
      const ctx = await setup({ extra: { [file]: `x\n${line}\n` } });
      expect((await byId(IGNORE).precheck(ctx)).kind, `${file}:${line}`).toBe('satisfied');
      await cleanup(fixture as string);
    }
    const ctx = await setup({
      extra: { '.gitignore': '# bugsee.properties\n!android/bugsee.properties\n' },
    });
    expect((await byId(IGNORE).precheck(ctx)).kind).toBe('pending');
  });

  it('gitignore rollback leaves a user-owned entry untouched', async () => {
    const original = 'bugsee.properties\n';
    const ctx = await setup({ extra: { 'android/.gitignore': original } });
    await byId(IGNORE).rollback(ctx);
    expect(await readFixture(fixture as string, 'android/.gitignore')).toBe(original);
  });
});

describe('stripOwn', () => {
  it('returns text without markers unchanged', () => {
    expect(stripOwn('a\nb\n')).toBe('a\nb\n');
  });

  it('removes a line marked :line but not a user line that merely mentions the id', () => {
    expect(
      stripOwn('x\nfoo() // bugsee:wizard:rn-gradle:line\ny // bugsee:wizard:rn-gradle\n'),
    ).toBe('x\ny // bugsee:wizard:rn-gradle\n');
  });

  it('restores a rewritten line and drops exactly N replacement lines', () => {
    const text = '  // bugsee:wizard:rn-gradle:orig:2 old line // c\n  new1\n  new2\nkeep\n';
    expect(stripOwn(text)).toBe('  old line // c\nkeep\n');
  });
});

// Satisfy lint for the unused import in some branches.
void mkdir;
void writeFile;
void readFile;

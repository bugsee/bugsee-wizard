import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

import type { WizardContext } from '../../src/core/context.js';
import { createLogger } from '../../src/core/logger.js';
import type {
  AndroidContext,
  AndroidOptions,
  AndroidPaths,
  BuildScriptStyle,
  GradleDsl,
} from '../../src/recipes/android/types.js';

export async function makeFixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bugsee-wizard-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

export async function readFixture(dir: string, rel: string): Promise<string> {
  return readFile(path.join(dir, rel), 'utf8');
}

export async function fixtureExists(dir: string, rel: string): Promise<boolean> {
  try {
    await readFile(path.join(dir, rel));
    return true;
  } catch {
    return false;
  }
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

interface MakeContextOpts {
  cwd: string;
  dsl: GradleDsl;
  style?: BuildScriptStyle;
  androidOptions?: Partial<AndroidOptions>;
  tokens?: Readonly<Record<string, string>>;
  dryRun?: boolean;
}

export function makeAndroidContext(opts: MakeContextOpts): AndroidContext {
  const settingsRel = opts.dsl === 'kotlin' ? 'settings.gradle.kts' : 'settings.gradle';
  const projectRel = opts.dsl === 'kotlin' ? 'build.gradle.kts' : 'build.gradle';
  const appRel = opts.dsl === 'kotlin' ? 'app/build.gradle.kts' : 'app/build.gradle';
  const paths: AndroidPaths = {
    settingsGradle: path.join(opts.cwd, settingsRel),
    settingsGradleDsl: opts.dsl,
    projectBuildGradle: path.join(opts.cwd, projectRel),
    projectBuildGradleDsl: opts.dsl,
    appBuildGradle: path.join(opts.cwd, appRel),
    appBuildGradleDsl: opts.dsl,
    appBuildScriptStyle: opts.style ?? 'plugins-dsl',
    appManifest: path.join(opts.cwd, 'app/src/main/AndroidManifest.xml'),
    bugseeProperties: path.join(opts.cwd, 'bugsee.properties'),
    gitignore: path.join(opts.cwd, '.gitignore'),
  };
  const androidOptions: AndroidOptions = {
    initMode: 'automatic',
    ndk: false,
    feedback: false,
    sizeAnalysis: false,
    providerProcessOverride: null,
    ...opts.androidOptions,
  };
  const base: WizardContext = {
    cwd: opts.cwd,
    debug: false,
    dryRun: opts.dryRun ?? false,
    kind: 'android',
    tokens: opts.tokens ?? { android: 'TEST_TOKEN' },
    log: createLogger({ debug: false }),
  };
  return { ...base, kind: 'android', androidOptions, androidPaths: paths };
}

export const SAMPLE_KOTLIN_SETTINGS_NO_MAVEN = `pluginManagement {
    repositories {
        gradlePluginPortal()
        google()
    }
}

rootProject.name = "MyApp"
include(":app")
`;

export const SAMPLE_KOTLIN_SETTINGS_WITH_MAVEN = `pluginManagement {
    repositories {
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}

rootProject.name = "MyApp"
include(":app")
`;

export const SAMPLE_GROOVY_SETTINGS_NO_MAVEN = `pluginManagement {
    repositories {
        gradlePluginPortal()
        google()
    }
}

rootProject.name = "MyApp"
include ':app'
`;

export const SAMPLE_KOTLIN_APP_BUILD = `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.myapp"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.example.myapp"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
}
`;

export const SAMPLE_GROOVY_APP_BUILD = `plugins {
    id 'com.android.application'
    id 'org.jetbrains.kotlin.android'
}

android {
    namespace 'com.example.myapp'
    compileSdk 34

    defaultConfig {
        applicationId 'com.example.myapp'
        minSdk 24
        targetSdk 34
        versionCode 1
        versionName '1.0'
    }
}

dependencies {
    implementation 'androidx.core:core-ktx:1.12.0'
}
`;

export const SAMPLE_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:label="MyApp">
        <activity android:name=".MainActivity" android:exported="true" />
    </application>
</manifest>
`;

// Kotlin DSL `app/build.gradle.kts` in legacy-apply shape — uses
// `apply(plugin = "…")` instead of a `plugins {}` block. Rare in practice
// (Kotlin DSL projects almost always use the modern plugins block) but
// supported for completeness.
export const SAMPLE_KOTLIN_LEGACY_APP_BUILD = `apply(plugin = "com.android.application")
apply(plugin = "org.jetbrains.kotlin.android")

android {
    namespace = "com.example.legacy"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.example.legacy"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
}
`;

// React Native-style app/build.gradle (legacy `apply plugin:` syntax,
// no plugins {} DSL block). Mirrors the layout RN's Android template
// generates as of RN 0.74.
export const SAMPLE_RN_APP_BUILD = `apply plugin: "com.android.application"
apply plugin: "org.jetbrains.kotlin.android"
apply plugin: "com.facebook.react"

android {
    namespace "com.awesomeproject"
    compileSdk 34

    defaultConfig {
        applicationId "com.awesomeproject"
        minSdk 23
        targetSdk 34
        versionCode 1
        versionName "1.0"
    }
}

dependencies {
    implementation("com.facebook.react:react-android")
}
`;

// React Native-style project-level build.gradle with a buildscript block
// that already includes some classpath entries.
export const SAMPLE_RN_PROJECT_BUILD = `buildscript {
    ext {
        buildToolsVersion = "34.0.0"
        minSdkVersion = 23
        compileSdkVersion = 34
        targetSdkVersion = 34
        kotlinVersion = "1.9.24"
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

// Project-level build.gradle for modern AGP projects — typically empty
// or only contains a top-level plugins block with `apply false` lines.
export const SAMPLE_KOTLIN_PROJECT_BUILD = `plugins {
    id("com.android.application") version "8.2.0" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
`;

export const SAMPLE_GROOVY_PROJECT_BUILD = `plugins {
    id 'com.android.application' version '8.2.0' apply false
    id 'org.jetbrains.kotlin.android' version '1.9.24' apply false
}
`;

// All step modules touch @clack/prompts via their imports of the logger,
// which forwards to clack.log.*. Tests mock clack so prompts can't hang.
export function mockClack(): void {
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
}

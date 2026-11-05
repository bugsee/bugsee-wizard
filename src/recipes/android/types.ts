import type { WizardContext } from '../../core/context.js';

export type GradleDsl = 'kotlin' | 'groovy';
export type AndroidInitMode = 'automatic' | 'manual';

/**
 * `plugins-dsl` — the modern `plugins { id("…") version "…" }` block.
 * `legacy-apply` — the older `apply plugin: "…"` syntax used by RN's
 * Android template and many pre-AGP-7 projects. Plugins applied this way
 * require a `classpath(...)` entry in the *project-level* `build.gradle`
 * `buildscript { dependencies }` block to be resolvable.
 */
export type BuildScriptStyle = 'plugins-dsl' | 'legacy-apply';

export interface AndroidOptions {
  readonly initMode: AndroidInitMode;
  readonly ndk: boolean;
  readonly feedback: boolean;
  readonly sizeAnalysis: boolean;
  /**
   * When the user's `<application>` declares `android:process="X"`, the
   * SDK's auto-init `ContentProvider` won't fire in that process. If set,
   * the wizard re-declares the provider with this process name (and
   * `tools:replace="android:process"` so manifest merger picks it up).
   *
   * Set to `null` for single-process apps and for users who declined the
   * auto-add prompt — they get the snippet in the next-steps note instead.
   */
  readonly providerProcessOverride: string | null;
}

export interface AndroidPaths {
  readonly settingsGradle: string;
  readonly settingsGradleDsl: GradleDsl;
  /** Root build script; `null` when absent in a plugins-DSL project (only legacy-apply needs it). */
  readonly projectBuildGradle: string | null;
  readonly projectBuildGradleDsl: GradleDsl | null;
  readonly appBuildGradle: string;
  readonly appBuildGradleDsl: GradleDsl;
  readonly appBuildScriptStyle: BuildScriptStyle;
  readonly appManifest: string;
  /** `<root>/bugsee.properties` — written by the wizard, read by the plugin. */
  readonly bugseeProperties: string;
  /** `<root>/.gitignore` — wizard ensures bugsee.properties is in here. */
  readonly gitignore: string;
}

export interface AndroidContext extends WizardContext {
  readonly kind: 'android';
  readonly androidOptions: AndroidOptions;
  readonly androidPaths: AndroidPaths;
}

export const BUGSEE_PLUGIN_ID = 'com.bugsee.android.gradle';
export const BUGSEE_PLUGIN_VERSION = '4.0.0-beta6';
export const BUGSEE_GRADLE_PLUGIN_ARTIFACT = 'com.bugsee:bugsee-android-gradle-plugin';

// Token storage moved from Android Studio's `local.properties` to a
// dedicated `bugsee.properties` at the root of the user's project. The
// plugin reads this file directly (build-time concerns); the wizard
// reads it via a small Gradle loader only when automatic init mode is
// chosen, to substitute the token into a manifest placeholder.
export const PROPERTIES_FILE_NAME = 'bugsee.properties';
export const TOKEN_PROPERTY_KEY = 'app_token';
export const MANIFEST_PLACEHOLDER_KEY = 'bugseeAppToken';

export const LOADER_MARKER_BEGIN = '// bugsee:wizard:loader:begin';
export const LOADER_MARKER_END = '// bugsee:wizard:loader:end';
export const EXT_BLOCK_MARKER_BEGIN = '// bugsee:wizard:bugsee-block:begin';
export const EXT_BLOCK_MARKER_END = '// bugsee:wizard:bugsee-block:end';
export const PLACEHOLDER_MARKER_BEGIN = '// bugsee:wizard:manifest-placeholder:begin';
export const PLACEHOLDER_MARKER_END = '// bugsee:wizard:manifest-placeholder:end';
export const MANIFEST_META_MARKER_BEGIN = '<!-- bugsee:wizard:meta:begin -->';
export const MANIFEST_META_MARKER_END = '<!-- bugsee:wizard:meta:end -->';
export const PROVIDER_OVERRIDE_MARKER_BEGIN = '<!-- bugsee:wizard:provider-override:begin -->';
export const PROVIDER_OVERRIDE_MARKER_END = '<!-- bugsee:wizard:provider-override:end -->';
export const APPLY_PLUGIN_MARKER_BEGIN = '// bugsee:wizard:apply-plugin:begin';
export const APPLY_PLUGIN_MARKER_END = '// bugsee:wizard:apply-plugin:end';
export const BUILDSCRIPT_CLASSPATH_MARKER_BEGIN = '// bugsee:wizard:buildscript-classpath:begin';
export const BUILDSCRIPT_CLASSPATH_MARKER_END = '// bugsee:wizard:buildscript-classpath:end';

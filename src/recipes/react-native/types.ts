import type { WizardContext } from '../../core/context.js';

/**
 * Native: SDK is launched in iOS AppDelegate / Android Application class.
 * The `react-native-bugsee` JS layer wires to the already-running SDK
 * via `await Bugsee.initialize()`. Captures crashes, console output,
 * and network events from the first ms of process lifetime; filters set
 * in JS only apply once the bridge comes up.
 *
 * JavaScript: SDK is launched from JS via `await Bugsee.launch(token)`.
 * Filters apply to every event, but events from before the JS bridge is
 * up are missed.
 */
export type RnLaunchPath = 'native' | 'javascript';

export type JsEntryLanguage = 'tsx' | 'ts' | 'jsx' | 'js';

/** Result of scanning the RN root for the JS launch entry point. */
export interface JsEntry {
  readonly path: string;
  readonly language: JsEntryLanguage;
  /**
   * Where in the file we want to land the launch line — `app-component`
   * if the file appears to be `App.tsx`/`App.jsx` (we splice into the
   * component), `top-level` if it's `index.js` (we splice near the top).
   */
  readonly kind: 'app-component' | 'top-level';
}

export interface RnPlatformPaths {
  readonly androidPath: string | null;
  readonly iosPath: string | null;
  readonly packageJson: string;
  readonly jsEntry: JsEntry | null;
  /**
   * Absolute path of `app.json` (with an `expo` key) when the project depends on `expo`, else
   * null. An Expo project gets the config-plugin step instead of the bare Android/iOS edits.
   */
  readonly expoConfig: string | null;
}

/** The native pins of the installed `@bugsee/react-native` (its `native-versions.json`). */
export interface RnNativeVersions {
  readonly androidSdk: string;
  readonly androidGradlePlugin: string;
  readonly iosSdk: string;
}

export interface RnOptions {
  readonly launchPath: RnLaunchPath;
  /** Auto-inject Bugsee.launch / Bugsee.initialize into the JS entry. */
  readonly autoInjectJsEntry: boolean;
  /** Run `npm install` / `yarn install` after editing package.json. */
  readonly runPackageInstall: boolean;
  /** Versions the Android/iOS snippets must name (from the installed package, else the fallback). */
  readonly nativeVersions: RnNativeVersions;
}

export interface RnContext extends WizardContext {
  readonly kind: 'react-native';
  readonly rnPaths: RnPlatformPaths;
  readonly rnOptions: RnOptions;
}

export const RN_PACKAGE_NAME = 'react-native-bugsee';
// Pin a min version that matches what we've validated. Bugsee will
// publish updates and consumers can bump manually; the wizard only
// guarantees a known-good baseline.
export const RN_PACKAGE_VERSION = '^4.0.0';

export const PACKAGE_JSON_MARKER = '"react-native-bugsee"';

export const JS_LAUNCH_MARKER_BEGIN = '// bugsee:wizard:rn-launch:begin';
export const JS_LAUNCH_MARKER_END = '// bugsee:wizard:rn-launch:end';
export const JS_INIT_MARKER_BEGIN = '// bugsee:wizard:rn-init:begin';
export const JS_INIT_MARKER_END = '// bugsee:wizard:rn-init:end';

/**
 * The native pins of `@bugsee/react-native` 7.0.0-beta3, for a run where the package is not
 * installed yet (install declined). The installed package's `native-versions.json` wins.
 */
export const RN_NATIVE_FALLBACK: RnNativeVersions = {
  androidSdk: '7.4.2',
  androidGradlePlugin: '4.0.8',
  iosSdk: '7.0.0',
};

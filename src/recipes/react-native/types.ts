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
}

export interface RnOptions {
  readonly launchPath: RnLaunchPath;
  /** Auto-inject Bugsee.launch / Bugsee.initialize into the JS entry. */
  readonly autoInjectJsEntry: boolean;
  /** Run `npm install` / `yarn install` after editing package.json. */
  readonly runPackageInstall: boolean;
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

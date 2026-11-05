import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import * as clack from '@clack/prompts';
import semver from 'semver';

import * as ask from '../../core/ask.js';
import type { WizardOptions } from '../../core/context.js';
import { createLogger } from '../../core/logger.js';
import type { RecipeResult, RollbackResult } from '../../core/result.js';
import { runRollback, runSteps, type Step, type StepResult } from '../../core/step.js';
import { runAndroidRollback } from '../android/run.js';
import { isPodOnPath } from '../ios/pod.js';
import { runIosRollback } from '../ios/run.js';
import { readInstalledNativeVersions } from './native-versions.js';
import { detectPackageManager, isManagerOnPath } from './package-manager.js';
import { discoverRnPaths } from './paths.js';
import { MIN_REACT_NATIVE, readRnProjectInfo, usesPodsForWrapper } from './project-info.js';
import { androidGradleSteps } from './steps/android-gradle.js';
import { ensureRnBugseePackageStep } from './steps/ensure-rn-bugsee-package.js';
import { expoPluginSnippet, expoPluginStep } from './steps/expo-plugin.js';
import { injectJsEntryStep, launchStatement, SNIPPET_NOTE_MARK } from './steps/inject-js-entry.js';
import { iosXcodeSteps } from './steps/ios-xcode.js';
import { rnPnpmBuildsStep } from './steps/pnpm-builds.js';
import { runPackageInstallStep } from './steps/run-package-install.js';
import { runRnPodInstallStep } from './steps/run-rn-pod-install.js';
import {
  JS_INIT_MARKER_BEGIN,
  LEGACY_RN_PACKAGE_NAME,
  RN_NATIVE_FALLBACK,
  RN_PACKAGE_NAME,
  RN_PACKAGE_VERSION,
  type RnContext,
  type RnNativeVersions,
  type RnOptions,
} from './types.js';

export interface ReactNativeRecipeInput extends WizardOptions {}

const README_URL = 'https://github.com/bugsee/bugsee-react-native/tree/main/packages/react-native';

const TOKEN_VALIDATE = (v: string | undefined): string | undefined => {
  const trimmed = (v ?? '').trim();
  if (trimmed.length === 0) return 'Token is required';
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return 'Tokens are alphanumeric (with `.`, `_`, `-` permitted) — looks like extra characters got pasted';
  }
  return undefined;
};

async function pickPlatforms(
  yes: boolean,
  hasAndroid: boolean,
  hasIos: boolean,
): Promise<readonly ('android' | 'ios')[] | null> {
  const both = hasAndroid && hasIos;
  if (!both) {
    if (hasAndroid) return ['android'];
    if (hasIos) return ['ios'];
    return [];
  }
  const choice = await ask.select<'both' | 'android' | 'ios'>(yes, {
    message: 'Set up Bugsee for which platform?',
    options: [
      { value: 'both', label: 'Both Android and iOS' },
      { value: 'android', label: 'Android only' },
      { value: 'ios', label: 'iOS only' },
    ],
    initialValue: 'both',
  });
  if (clack.isCancel(choice)) return null;
  if (choice === 'both') return ['android', 'ios'];
  return [choice];
}

async function askToken(label: string): Promise<string | null> {
  const ans = await clack.text({
    message: `Bugsee app token (${label})`,
    placeholder: 'paste from your Bugsee dashboard',
    validate: TOKEN_VALIDATE,
  });
  return clack.isCancel(ans) ? null : ans.trim();
}

/** Every step the wizard can apply, in install order (rollback walks it backwards). */
const PACKAGE_STEPS: Step<RnContext>[] = [
  ensureRnBugseePackageStep,
  rnPnpmBuildsStep,
  runPackageInstallStep,
];
const SETUP_STEPS: Step<RnContext>[] = [
  injectJsEntryStep,
  expoPluginStep,
  ...androidGradleSteps,
  ...iosXcodeSteps,
  runRnPodInstallStep,
];

function makeContext(
  input: WizardOptions,
  base: Omit<
    RnContext,
    | 'cwd'
    | 'debug'
    | 'dryRun'
    | 'nonInteractive'
    | 'json'
    | 'ignoreGitChanges'
    | 'yes'
    | 'kind'
    | 'log'
  >,
): RnContext {
  return {
    cwd: input.cwd,
    debug: input.debug,
    dryRun: input.dryRun,
    nonInteractive: false,
    json: false,
    ignoreGitChanges: false,
    yes: input.yes,
    kind: 'react-native',
    log: createLogger({ debug: input.debug }),
    ...base,
  };
}

/** `@bugsee/react-native` requires the New Architecture: say so when the project turns it off. */
async function warnIfNewArchitectureIsOff(
  rnRoot: string,
  expoConfig: string | null,
): Promise<void> {
  let off = false;
  const gradleProps = await readFile(
    path.join(rnRoot, 'android', 'gradle.properties'),
    'utf8',
  ).catch(() => '');
  if (/^\s*newArchEnabled\s*=\s*false\s*$/m.test(gradleProps)) off = true;
  // a prebuilt Expo project carries it in ios/Podfile.properties.json
  const podProps = await readFile(
    path.join(rnRoot, 'ios', 'Podfile.properties.json'),
    'utf8',
  ).catch(() => '');
  if (/"newArchEnabled"\s*:\s*(?:"false"|false)/.test(podProps)) off = true;
  if (expoConfig !== null) {
    try {
      const app = JSON.parse(await readFile(expoConfig, 'utf8')) as {
        expo?: { newArchEnabled?: unknown };
      };
      if (app.expo?.newArchEnabled === false) off = true;
    } catch {
      // unreadable app.json: the Expo step reports it
    }
  }
  if (off) {
    clack.log.warn(
      `The New Architecture is switched off in this project, and ${RN_PACKAGE_NAME} requires it. Turn it back on (newArchEnabled).`,
    );
  }
}

export async function runReactNativeRecipe(input: ReactNativeRecipeInput): Promise<RecipeResult> {
  const paths = await discoverRnPaths(input.cwd);
  const info = await readRnProjectInfo(input.cwd);
  const expo = paths.expoConfig !== null;

  if (!paths.androidPath && !paths.iosPath && !info.hasExpo) {
    clack.log.warn('No `android/` or `ios/` subdirectory found at the project root.');
    return 'failed';
  }

  // The old wrapper is a different package with a different API: not an in-place upgrade.
  if (info.legacyPackage) {
    clack.log.error(
      [
        `This project uses ${LEGACY_RN_PACKAGE_NAME} (6.x). ${RN_PACKAGE_NAME} replaces it, but they are different`,
        'packages with different APIs, not an upgrade in place.',
        `Remove ${LEGACY_RN_PACKAGE_NAME} and its Bugsee code first (\`bugsee-wizard uninstall\` does that for what`,
        `the wizard added), then run the wizard again. Migration notes: ${README_URL}`,
      ].join('\n'),
    );
    return 'failed';
  }
  if (info.reactNativeVersion !== null && semver.lt(info.reactNativeVersion, MIN_REACT_NATIVE)) {
    clack.log.error(
      `${RN_PACKAGE_NAME} needs React Native ${MIN_REACT_NATIVE} or later (found ${info.reactNativeVersion}), with the New Architecture and Hermes.`,
    );
    return 'failed';
  }

  await warnIfNewArchitectureIsOff(input.cwd, paths.expoConfig);

  clack.log.info(
    `${RN_PACKAGE_NAME} is a beta (${RN_PACKAGE_VERSION}): its API can still change between betas.`,
  );

  // 1. Platforms (an Expo project builds both).
  const targets =
    expo || info.hasExpo
      ? (['android', 'ios'] as const)
      : await pickPlatforms(input.yes, !!paths.androidPath, !!paths.iosPath);
  if (targets === null) {
    clack.cancel('Cancelled.');
    return 'cancelled';
  }
  if (targets.length === 0) {
    clack.log.warn('Nothing to do.');
    return 'cancelled';
  }

  // 2. Per-platform tokens (Bugsee issues a separate one per platform).
  const tokens: Record<string, string> = {};
  for (const platform of targets) {
    const token = await askToken(platform === 'android' ? 'Android' : 'iOS');
    if (token === null) {
      clack.cancel('Cancelled.');
      return 'cancelled';
    }
    tokens[platform] = token;
  }

  // 3. JS entry, package install, native edits, pod install.
  const jsEntryLabel = paths.jsEntry ? paths.jsEntry.path.split('/').slice(-2).join('/') : null;
  const autoInjectJsEntry = await ask.confirm(input.yes, {
    message: jsEntryLabel
      ? `Add the Bugsee launch to ${jsEntryLabel}?`
      : 'Add the Bugsee launch? (no entry file found — will print a snippet instead)',
    initialValue: paths.jsEntry !== null,
  });
  if (clack.isCancel(autoInjectJsEntry)) {
    clack.cancel('Cancelled.');
    return 'cancelled';
  }

  const manager = await detectPackageManager(input.cwd);
  const managerAvailable = isManagerOnPath(manager);
  const runPackageInstall = await ask.confirm(input.yes, {
    message: managerAvailable
      ? `Run \`${manager} install\` now to fetch ${RN_PACKAGE_NAME}?`
      : `Run \`${manager} install\` now? (${manager} is not on PATH — this will fail unless installed first)`,
    initialValue: managerAvailable,
  });
  if (clack.isCancel(runPackageInstall)) {
    clack.cancel('Cancelled.');
    return 'cancelled';
  }

  // A bare app needs native edits for Android network capture and release symbolication.
  let applyNative = false;
  if (!expo && !info.hasExpo) {
    const answer = await ask.confirm(input.yes, {
      message:
        'Apply the native edits (Android: Bugsee Gradle plugin + source-map hook; iOS: Xcode bundle phase + dSYM upload)? Without them Android records no network events and release crashes are not symbolicated.',
      initialValue: true,
    });
    if (clack.isCancel(answer)) {
      clack.cancel('Cancelled.');
      return 'cancelled';
    }
    applyNative = answer;
  }

  // Before React Native 0.87 the iOS SDK comes through the wrapper's pod.
  const usesPods =
    !expo &&
    !info.hasExpo &&
    targets.includes('ios') &&
    paths.iosPath !== null &&
    usesPodsForWrapper(info.reactNativeVersion);
  const podsNeeded = usesPods && runPackageInstall;
  let runPodInstall = false;
  if (podsNeeded) {
    const podAvailable = isPodOnPath();
    const answer = await ask.confirm(input.yes, {
      message: podAvailable
        ? 'Run `pod install` now to fetch the Bugsee iOS SDK?'
        : 'Run `pod install` now? (CocoaPods is not on PATH — this will fail unless installed first)',
      initialValue: podAvailable,
    });
    if (clack.isCancel(answer)) {
      clack.cancel('Cancelled.');
      return 'cancelled';
    }
    runPodInstall = answer;
  }

  const options = (nativeVersions: RnNativeVersions): RnOptions => ({
    autoInjectJsEntry,
    runPackageInstall,
    runPodInstall,
    nativeVersions,
  });
  const contextFor = (nativeVersions: RnNativeVersions): RnContext =>
    makeContext(input, {
      tokens,
      // the native steps edit what exists in androidPath / iosPath: an Expo project's native files
      // are the config plugin's to write, and without consent nothing native is touched
      rnPaths: applyNative ? paths : { ...paths, androidPath: null, iosPath: null },
      rnOptions: options(nativeVersions),
    });

  // 4. Phase one: the package. The native steps need the versions it pins.
  const packageCtx = contextFor(RN_NATIVE_FALLBACK);
  const packageResult = await runSteps(PACKAGE_STEPS, packageCtx);
  if (packageResult.failed) {
    clack.log.error('Adding the package failed; previous changes were rolled back.');
    return 'failed';
  }
  const installed = await readInstalledNativeVersions(input.cwd);
  if (installed === null && runPackageInstall && !input.dryRun) {
    clack.log.warn(
      `Could not read native-versions.json from the installed ${RN_PACKAGE_NAME}; using the versions this wizard was written against.`,
    );
  }

  // 5. Phase two: the JS launch, the native setup, pod install.
  const setupCtx = contextFor(installed ?? RN_NATIVE_FALLBACK);
  const setupResult = await runSteps(SETUP_STEPS, setupCtx);
  if (setupResult.failed) {
    clack.log.error('Setup failed; rolling back the React Native changes.');
    // only what this run applied: a dependency the user already had stays
    const applied = (id: string) =>
      packageResult.results.some((r) => r.id === id && r.outcome === 'applied');
    const undo = await runRollback(
      PACKAGE_STEPS.filter((step) => applied(step.id)),
      packageCtx,
    );
    if (applied(ensureRnBugseePackageStep.id) && applied(runPackageInstallStep.id)) {
      clack.log.warn(
        `\`${manager} install\` already ran: node_modules and the lockfile still contain ${RN_PACKAGE_NAME}. Run \`${manager} remove ${RN_PACKAGE_NAME}\` to clear them.`,
      );
    }
    if (undo.failed) {
      clack.log.error(
        'Some changes could not be rolled back — check package.json and your JS entry file.',
      );
    }
    return 'failed';
  }

  // 6. What is left for the user.
  for (const r of [...packageResult.results, ...setupResult.results]) {
    if (r.snippet) clack.note(`${r.snippet.file}\n\n${r.snippet.code}`, r.snippet.title);
  }
  if (!expo && info.hasExpo) {
    clack.note(
      `Your Expo config is not app.json, which the wizard cannot edit. Add the plugin to it:\n\n${expoPluginSnippet(tokens)}`,
      'Expo config plugin',
    );
  }
  clack.note(
    summaryLines({
      manager,
      runPackageInstall,
      runPodInstall,
      usesPods,
      applyNative,
      bare: !expo && !info.hasExpo,
      expo: expo || info.hasExpo,
      autoInjectJsEntry,
      entryNeedsSnippet: setupResult.results.some(
        (r) => r.id === injectJsEntryStep.id && r.note?.includes(SNIPPET_NOTE_MARK) === true,
      ),
      tokens,
      results: setupResult.results,
    }).join('\n'),
    'Done',
  );
  return 'ok';
}

function summaryLines(s: {
  manager: string;
  runPackageInstall: boolean;
  runPodInstall: boolean;
  usesPods: boolean;
  applyNative: boolean;
  bare: boolean;
  expo: boolean;
  autoInjectJsEntry: boolean;
  /** The inject step skipped itself because there is no (readable) entry file. */
  entryNeedsSnippet: boolean;
  tokens: Readonly<Record<string, string>>;
  results: readonly StepResult[];
}): string[] {
  const lines: string[] = [];
  if (!s.runPackageInstall) lines.push(`Run \`${s.manager} install\` to fetch ${RN_PACKAGE_NAME}.`);
  if (s.bare) {
    if (s.tokens.ios !== undefined) {
      if (!s.usesPods) {
        lines.push(
          'iOS: React Native 0.87+ resolves the Bugsee SDK through Swift Package Manager.',
        );
      } else if (!s.runPodInstall) {
        lines.push('Run `pod install` from your `ios/` directory (React Native before 0.87).');
      }
    }
    if (!s.applyNative) {
      lines.push(
        `Android network capture and release symbolication need the native edits; see ${README_URL}`,
      );
    }
  }
  if (s.manager === 'pnpm') {
    lines.push('pnpm: React Native needs `nodeLinker: hoisted` in pnpm-workspace.yaml.');
  }
  if (s.expo) {
    lines.push(
      'Expo: run `expo prebuild` if you commit android/ and ios/ (the plugin writes them). Expo Go is not supported; use a development build.',
    );
  }
  const launch = launchStatement(s.tokens, 'Platform');
  if ((!s.autoInjectJsEntry || s.entryNeedsSnippet) && launch !== null) {
    lines.push(
      '',
      'Add to your App.tsx / index.js:',
      '',
      `  import Bugsee from '${RN_PACKAGE_NAME}';`,
      `  import { Platform } from 'react-native';`,
      '',
      ...launch.split('\n').map((l) => `  ${l}`),
    );
  }
  lines.push(
    '',
    'Requires the New Architecture and Hermes (React Native defaults).',
    'To report render errors, wrap the root: AppRegistry.registerComponent(name, () => Bugsee.wrap(App)).',
    'React Native frames in iOS crashes need `RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS=1 pod install` (see the README).',
  );
  return lines;
}

/** The files the old wizard's JS step could have written to, as `discoverJsEntry` knows them. */
const ENTRY_FILES = ['App.tsx', 'App.jsx', 'App.ts', 'App.js', 'index.js', 'index.ts', 'index.tsx'];

/** The old package imported or required, in either quote style. */
const OLD_PACKAGE_REF = new RegExp(`['"]${LEGACY_RN_PACKAGE_NAME}['"]`);

/**
 * What the earlier native recipes wrote (their fixed marker names, the old iOS post-action's
 * title). This version's own markers are all `bugsee:wizard:rn-…`, which this does not match.
 */
const OLD_NATIVE_MARKER =
  /bugsee:wizard:(?:loader|bugsee-block|manifest-placeholder|meta|provider-override|apply-plugin|buildscript-classpath|pod|import|launch)\b|Bugsee Symbolication/;

const NATIVE_FILE = /(?:\.(?:gradle|kts|xml|swift|m|mm|h|xcscheme)|^Podfile)$/;
// Android resources and assets are never edited by the old recipes, and are most of a large app's files.
const SKIP_DIRS = new Set([
  'Pods',
  'build',
  'node_modules',
  '.gradle',
  '.git',
  'DerivedData',
  'res',
  'assets',
]);

/**
 * A bounded breadth-first walk over android/ and ios/ for a file holding one of the old recipes'
 * markers: the shallow files (build.gradle, Podfile, AppDelegate, schemes) are looked at before
 * the deep ones, so a large app cannot use the budget up before reaching them.
 */
async function hasOldNativeMarker(root: string, maxFiles = 3000): Promise<boolean> {
  const queue = [root];
  let seen = 0;
  while (queue.length > 0 && seen < maxFiles) {
    const dir = queue.shift() as string;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(full);
      } else if (NATIVE_FILE.test(e.name) && seen++ < maxFiles) {
        const text = await readFile(full, 'utf8').catch(() => '');
        if (OLD_NATIVE_MARKER.test(text)) return true;
      }
    }
  }
  return false;
}

/**
 * Evidence of an earlier wizard's install: the old package, its import or init block in a JS entry
 * file, or the earlier native recipes' own markers in android/ or ios/.
 */
async function hasEarlierWizardInstall(
  rnRoot: string,
  paths: Awaited<ReturnType<typeof discoverRnPaths>>,
): Promise<boolean> {
  if ((await readRnProjectInfo(rnRoot)).legacyPackage) return true;
  for (const name of ENTRY_FILES) {
    const text = await readFile(path.join(rnRoot, name), 'utf8').catch(() => '');
    if (text.includes(JS_INIT_MARKER_BEGIN) || OLD_PACKAGE_REF.test(text)) return true;
  }
  for (const dir of [paths.androidPath, paths.iosPath]) {
    if (dir !== null && (await hasOldNativeMarker(dir))) return true;
  }
  return false;
}

/**
 * Roll back everything the wizard added to an RN project: the new setup and package steps, and the
 * native recipes of earlier wizards (Android/iOS). Each step's rollback is a no-op when its target
 * state isn't present, so attempting everything is safe.
 */
export async function runReactNativeRollback(input: WizardOptions): Promise<RollbackResult> {
  const paths = await discoverRnPaths(input.cwd);
  const ctx = makeContext(input, {
    tokens: {},
    rnPaths: paths,
    rnOptions: {
      autoInjectJsEntry: false,
      runPackageInstall: false,
      runPodInstall: false,
      nativeVersions: (await readInstalledNativeVersions(input.cwd)) ?? RN_NATIVE_FALLBACK,
    },
  });
  // Earlier wizards also configured the native SDKs of the app itself. Their rollbacks act on files
  // the new steps touch too (an old step removes EVERY `app_token=` line of bugsee.properties,
  // including a user's own), so they run only where there is evidence of such an install: the old
  // package, or the launch/init block it injected. They go first, and the new steps' rollback,
  // which restores the user's own lines from its markers, has the last word.
  let failed = false;
  if (await hasEarlierWizardInstall(input.cwd, paths)) {
    if (paths.androidPath) {
      const res = await runAndroidRollback({ ...input, cwd: paths.androidPath });
      if (res === 'failed') failed = true;
    }
    if (paths.iosPath) {
      const res = await runIosRollback({ ...input, cwd: paths.iosPath });
      if (res === 'failed') failed = true;
    }
  }
  if ((await runRollback([...PACKAGE_STEPS, ...SETUP_STEPS], ctx)).failed) failed = true;
  return failed ? 'failed' : 'ok';
}

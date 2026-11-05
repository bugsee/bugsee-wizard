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
import { injectJsEntryStep } from './steps/inject-js-entry.js';
import { iosXcodeSteps } from './steps/ios-xcode.js';
import { rnPnpmBuildsStep } from './steps/pnpm-builds.js';
import { runPackageInstallStep } from './steps/run-package-install.js';
import { runRnPodInstallStep } from './steps/run-rn-pod-install.js';
import {
  LEGACY_RN_PACKAGE_NAME,
  RN_NATIVE_FALLBACK,
  RN_PACKAGE_NAME,
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
  const podsNeeded =
    !expo &&
    !info.hasExpo &&
    targets.includes('ios') &&
    paths.iosPath !== null &&
    runPackageInstall &&
    usesPodsForWrapper(info.reactNativeVersion);
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
      rnPaths: applyNative || expo ? paths : { ...paths, androidPath: null, iosPath: null },
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
    const undo = await runRollback(PACKAGE_STEPS, packageCtx);
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
      podsNeeded,
      applyNative,
      bare: !expo && !info.hasExpo,
      autoInjectJsEntry,
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
  podsNeeded: boolean;
  applyNative: boolean;
  bare: boolean;
  autoInjectJsEntry: boolean;
  tokens: Readonly<Record<string, string>>;
  results: readonly StepResult[];
}): string[] {
  const lines: string[] = [];
  if (!s.runPackageInstall) lines.push(`Run \`${s.manager} install\` to fetch ${RN_PACKAGE_NAME}.`);
  if (s.bare) {
    if (s.runPackageInstall && !s.podsNeeded && s.tokens.ios !== undefined) {
      lines.push('iOS: React Native 0.87+ resolves the Bugsee SDK through Swift Package Manager.');
    } else if (!s.runPodInstall && s.tokens.ios !== undefined) {
      lines.push('Run `pod install` from your `ios/` directory (React Native before 0.87).');
    }
    if (!s.applyNative) {
      lines.push(
        `Android network capture and release symbolication need the native edits; see ${README_URL}`,
      );
    }
  }
  if (!s.autoInjectJsEntry) {
    lines.push(
      '',
      'Add to your App.tsx / index.js:',
      '',
      `  import Bugsee from '${RN_PACKAGE_NAME}';`,
      `  import { Platform } from 'react-native';`,
      '',
      `  Bugsee.launch(Platform.OS === 'ios' ? '${s.tokens.ios ?? '<IOS_TOKEN>'}' : '${s.tokens.android ?? '<ANDROID_TOKEN>'}');`,
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
  let failed = (await runRollback([...PACKAGE_STEPS, ...SETUP_STEPS], ctx)).failed;

  // Earlier wizards also configured the native SDKs of the app itself.
  if (paths.androidPath) {
    const res = await runAndroidRollback({ ...input, cwd: paths.androidPath });
    if (res === 'failed') failed = true;
  }
  if (paths.iosPath) {
    const res = await runIosRollback({ ...input, cwd: paths.iosPath });
    if (res === 'failed') failed = true;
  }
  return failed ? 'failed' : 'ok';
}
